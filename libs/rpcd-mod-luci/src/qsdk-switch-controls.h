/* SPDX-License-Identifier: ISC */
#include <sys/file.h>
#include <syslog.h>

struct qsdk_switch_port {
	unsigned int egress, ingress, storm, storm_mask, mirror_rx, mirror_tx, priority, dscp, up;
};
struct qsdk_switch_config { unsigned int monitor; struct qsdk_switch_port port[3]; };

static bool qsdk_ssdk_batch(const char *commands, char *result, size_t capacity)
{
	char directory[] = "/tmp/luci-ssdk.XXXXXX", input[80], output[80], text[1024];
	const char *argv[] = { "/usr/sbin/ssdk_sh", "run", input, output, NULL };
	FILE *file;
	bool success = false;
	size_t length;
	if (!mkdtemp(directory)) return false;
	snprintf(input, sizeof(input), "%s/input", directory); snprintf(output, sizeof(output), "%s/output", directory);
	if (!(file = fopen(input, "w"))) goto out;
	if (fprintf(file, "device id set 1\n%s", commands) < 0) { fclose(file); goto out; }
	if (fclose(file) || !qsdk_exec_capture(argv, text, sizeof(text), 2000, true) || !(file = fopen(output, "r"))) goto out;
	length = fread(result, 1, capacity-1, file);
	if (!ferror(file) && fgetc(file) == EOF) { result[length] = 0; success = true; }
	fclose(file);
out:
	unlink(input); unlink(output); rmdir(directory); return success;
}

static bool qsdk_ssdk_field(const char *text, const char *command, const char *key, unsigned int *value)
{
	char token[80], *end;
	const char *start = strstr(text, command), *done, *field, *limit;
	unsigned long number;
	if (!start || (start != text && start[-1] != '\n') || start[strlen(command)] != '\n' || !(done = strstr(start, "operation done."))) return false;
	limit=strstr(start,"\n\n");
	if(limit && done>=limit) return false;
	snprintf(token, sizeof(token), "[%s]:", key);
	if (!(field = strstr(start, token)) || field >= done) return false;
	field += strlen(token);
	if (!strncmp(field, "ENABLE", 6) || !strncmp(field, "yes", 3)) { *value = 1; return true; }
	if (!strncmp(field, "DISABLE", 7) || !strncmp(field, "no", 2)) { *value = 0; return true; }
	if (!isdigit((unsigned char)*field)) return false;
	errno = 0; number = strtoul(field, &end, 0);
	if (errno || number > UINT32_MAX || end == field || (*end && !isspace((unsigned char)*end))) return false;
	*value = number; return true;
}

static bool qsdk_switch_read(struct qsdk_switch_config *config)
{
	char commands[4096] = "mirror analyPt get\n", command[80], result[16384];
	unsigned int port, unit, enabled, rate, mask, i;
	static const char *const gets[][2] = { {"mirror ptIngress", "Ingeress mirror"}, {"mirror ptEgress", "Egeress mirror"},
		{"qos ptDefaultCpri", "default cpri"}, {"qos ptMode", "Enable"}, {"qos ptMode", "Enable"} };
	memset(config, 0, sizeof(*config));
	for (port = 1; port <= 3; port++) {
		snprintf(command, sizeof(command), "rate portshaper get %u\nrate portpolicer get %u\n", port, port); strcat(commands, command);
		for (i=0; i<ARRAY_SIZE(gets); i++) { snprintf(command, sizeof(command), "%s get %u%s\n", gets[i][0], port, i==3?" dscp":i==4?" up":""); strcat(commands, command); }
		snprintf(command,sizeof(command),"qos ptDefaultSpri get %u\n",port);strcat(commands,command);
	}
	if (!qsdk_ssdk_batch(commands, result, sizeof(result)) || !qsdk_ssdk_field(result, "mirror analyPt get", "Port ID", &config->monitor)) return false;
	for (port = 1; port <= 3; port++) {
		struct qsdk_switch_port *p = &config->port[port-1];
		snprintf(command, sizeof(command), "rate portshaper get %u", port);
		if (!qsdk_ssdk_field(result, command, "Status", &enabled) || !qsdk_ssdk_field(result, command, "cir", &rate)) return false;
		p->egress = enabled ? rate : 0;
		unsigned int burst;
		if(!qsdk_ssdk_field(result,command,"cbs",&burst) || burst!=(enabled?32768:0)) return false;
		unsigned int v;
		if(!qsdk_ssdk_field(result,command,"byte_based",&v) || v!=1 || !qsdk_ssdk_field(result,command,"eir",&v) || v || !qsdk_ssdk_field(result,command,"ebs",&v) || v) return false;
		snprintf(command, sizeof(command), "rate portpolicer get %u", port);
		if (!qsdk_ssdk_field(result, command, "c_enable", &enabled) || !qsdk_ssdk_field(result, command, "cir", &rate) || !qsdk_ssdk_field(result, command, "c_rate_flag", &mask)) return false;
		/* The SDK uses meter_unit text, rather than a byte_based boolean here. */
		const char *start = strstr(result, command), *meter = start ? strstr(start, "[meter_unit]:") : NULL;
		if (!meter) return false;
		unit = !strncmp(meter+13, "byte_based", 10);
		if(!qsdk_ssdk_field(result,command,"cbs",&burst) || burst!=(enabled?(unit?32768:64):0)) return false;
		static const char *const unsupported[] = {"combine_mode","color_aware","couple_falg","deficit_falg","e_enable","eir","ebs","e_rate_flag"};
		for(i=0;i<ARRAY_SIZE(unsupported);i++) if(!qsdk_ssdk_field(result,command,unsupported[i],&v) || v) return false;
		if(enabled && unit && mask!=0xfe) return false;
		p->ingress = enabled && unit ? rate : 0; p->storm = enabled && !unit ? rate : 0; p->storm_mask = mask;
		unsigned int *values[] = { &p->mirror_rx, &p->mirror_tx, &p->priority, &p->dscp, &p->up };
		for (i=0; i<ARRAY_SIZE(gets); i++) {
			snprintf(command, sizeof(command), "%s get %u%s", gets[i][0], port, i==3?" dscp":i==4?" up":"");
			if (!qsdk_ssdk_field(result, command, gets[i][1], values[i])) return false;
		}
		snprintf(command,sizeof(command),"qos ptDefaultSpri get %u",port);
		if(!qsdk_ssdk_field(result,command,"default spri",&v) || v!=p->priority) return false;
	}
	return true;
}

static bool qsdk_switch_valid(const struct qsdk_switch_config *config)
{
	unsigned int i;
	if (config->monitor != 15 && (config->monitor < 1 || config->monitor > 3)) return false;
	for (i=0; i<3; i++) {
		const struct qsdk_switch_port *p = &config->port[i];
		if (p->egress>2500000 || (p->egress && p->egress<100) || p->ingress>2500000 || (p->ingress && p->ingress<100) ||
		    p->storm>1000000 || (p->storm && p->storm<157) || (p->ingress && p->storm) || (p->storm && (p->storm_mask & ~0x38)) ||
		    (p->storm && !p->storm_mask) || p->mirror_rx>1 || p->mirror_tx>1 || p->priority>7 || p->dscp>1 || p->up>1 ||
		    ((p->mirror_rx || p->mirror_tx) && (config->monitor==15 || config->monitor==i+1))) return false;
	}
	return true;
}

static bool qsdk_switch_write(const struct qsdk_switch_config *config)
{
	char commands[8192] = "", line[768], result[16384];
	unsigned int port, operations = 1, count = 0;
	const char *cursor;
	snprintf(line, sizeof(line), "mirror analyPt set %u\n", config->monitor); strcat(commands, line);
	for (port=1; port<=3; port++) {
		const struct qsdk_switch_port *p=&config->port[port-1];
		snprintf(line, sizeof(line),
			"rate portshaper set %u %s yes %u %u 0 0\n"
			"rate portpolicer set %u no %s no no no %s %u %u %u 1ms no 0 0 0 1ms\n"
			"mirror ptIngress set %u %s\nmirror ptEgress set %u %s\n"
			"qos ptDefaultCpri set %u %u\nqos ptDefaultSpri set %u %u\n"
			"qos ptMode set %u dscp %s\nqos ptMode set %u up %s\n",
			port,p->egress?"enable":"disable",p->egress,p->egress?32768:0,
			port,p->storm?"no":"yes",(p->ingress||p->storm)?"yes":"no",p->ingress?p->ingress:p->storm,p->ingress?32768:p->storm?100:0,p->storm?p->storm_mask:p->ingress?0xfe:0,
			port,p->mirror_rx?"enable":"disable",port,p->mirror_tx?"enable":"disable",port,p->priority,port,p->priority,
			port,p->dscp?"enable":"disable",port,p->up?"enable":"disable");
		strcat(commands,line); operations+=8;
	}
	if (!qsdk_ssdk_batch(commands,result,sizeof(result))) return false;
	for (cursor=result; (cursor=strstr(cursor,"operation done.")); cursor+=15) count++;
	return count==operations+1; /* Include the process-local device selector. */
}

static unsigned int qsdk_switch_rate(unsigned int rate,bool frames)
{
	/* QCA8386 inherits ISISC's MHT rate conversion, including its integer getter. */
	unsigned int hardware=frames?rate*4/625:rate/80;
	return frames?(hardware/4)*625+(hardware%4)*157:hardware*80;
}

static bool qsdk_switch_matches(const struct qsdk_switch_config *actual, const struct qsdk_switch_config *wanted)
{
	unsigned int i;
	if (actual->monitor!=wanted->monitor) return false;
	for (i=0;i<3;i++) {
		const struct qsdk_switch_port *a=&actual->port[i], *w=&wanted->port[i];
		if (a->mirror_rx!=w->mirror_rx || a->mirror_tx!=w->mirror_tx || a->priority!=w->priority || a->dscp!=w->dscp || a->up!=w->up ||
		    a->egress!=qsdk_switch_rate(w->egress,false) || a->ingress!=qsdk_switch_rate(w->ingress,false) ||
		    a->storm!=qsdk_switch_rate(w->storm,true) || (w->storm && a->storm_mask!=w->storm_mask)) return false;
	}
	return true;
}

static const char *const qsdk_switch_keys[] = {"egress","ingress","storm","storm_mask","mirror_rx","mirror_tx","priority","dscp","up"};

static bool qsdk_switch_store(struct qsdk_switch_config *config, bool write)
{
	struct uci_context *ctx=uci_alloc_context();
	struct uci_package *package=NULL;
	struct uci_section *section;
	struct uci_ptr ptr={};
	char name[16], number[32];
	unsigned int port,i;
	bool ok=false, created=false;
	if (!ctx) return false;
	if (uci_load(ctx,"luci_qsdk_switch",&package)) {
		if (!write || ctx->err != UCI_ERR_NOTFOUND) goto out;
		char initial[] = "config switch 'switch'\n\toption monitor '15'\n";
		FILE *stream=fmemopen(initial,strlen(initial),"r");
		if(!stream) goto out;
		int status=uci_import(ctx,stream,"luci_qsdk_switch",&package,true);fclose(stream);
		if(status || !package) goto out;
		created=true;
	}
	for(port=0;port<=3;port++) {
		snprintf(name,sizeof(name),port?"lan%u":"switch",port);
		section=uci_lookup_section(ctx,package,name);
		if (!section && write) {
			memset(&ptr,0,sizeof(ptr));ptr.p=package;ptr.section=name;ptr.value=port?"port":"switch";
			if(uci_set(ctx,&ptr)) goto out;
			section=uci_lookup_section(ctx,package,name);
		}
		if(!section) goto out;
		unsigned int *values=port?(unsigned int *)&config->port[port-1]:&config->monitor;
		for(i=0;i<(port?ARRAY_SIZE(qsdk_switch_keys):1);i++) {
			const char *key=port?qsdk_switch_keys[i]:"monitor";
			if(write) {
				snprintf(number,sizeof(number),"%u",values[i]);memset(&ptr,0,sizeof(ptr));ptr.p=package;ptr.s=section;ptr.option=key;ptr.value=number;
				if(uci_set(ctx,&ptr)) goto out;
			} else {
				const char *v=uci_lookup_option_string(ctx,section,key);uint64_t n;
				if(!v || !qsdk_counter(v,&n) || n>UINT32_MAX) goto out;
				values[i]=n;
			}
		}
	}
	ok=!write || !uci_commit(ctx,&package,created);
out:
	uci_free_context(ctx);return ok;
}

static void qsdk_switch_reply(struct blob_buf *buffer,const struct qsdk_switch_config *config)
{
	char name[8];void *ports,*table;unsigned int port,i;
	blobmsg_add_u32(buffer,"monitor",config->monitor);ports=blobmsg_open_table(buffer,"ports");
	for(port=0;port<3;port++) {
		snprintf(name,sizeof(name),"%u",port+1);table=blobmsg_open_table(buffer,name);
		const unsigned int *values=(const unsigned int *)&config->port[port];
		for(i=0;i<ARRAY_SIZE(qsdk_switch_keys);i++) blobmsg_add_u32(buffer,qsdk_switch_keys[i],values[i]);
		blobmsg_close_table(buffer,table);
	}
	blobmsg_close_table(buffer,ports);
}

static const struct blobmsg_policy qsdk_switch_policy[] = {
	{"monitor",BLOBMSG_TYPE_INT32},{"ports",BLOBMSG_TYPE_TABLE}
};

static bool qsdk_switch_parse(struct blob_attr *message,struct qsdk_switch_config *config)
{
	struct blob_attr *top[2],*ports[3],*values[9];unsigned int p,i;
	static const struct blobmsg_policy port_policy[]={{"1",BLOBMSG_TYPE_TABLE},{"2",BLOBMSG_TYPE_TABLE},{"3",BLOBMSG_TYPE_TABLE}};
	struct blobmsg_policy value_policy[9];
	if(!message) return false;
	blobmsg_parse(qsdk_switch_policy,2,top,blob_data(message),blob_len(message));
	if(!top[0] || !top[1]) return false;
	config->monitor=blobmsg_get_u32(top[0]);
	blobmsg_parse(port_policy,3,ports,blobmsg_data(top[1]),blobmsg_data_len(top[1]));
	for(i=0;i<9;i++) {value_policy[i].name=qsdk_switch_keys[i];value_policy[i].type=BLOBMSG_TYPE_INT32;}
	for(p=0;p<3;p++) {
		if(!ports[p]) return false;
		blobmsg_parse(value_policy,9,values,blobmsg_data(ports[p]),blobmsg_data_len(ports[p]));
		unsigned int *v=(unsigned int *)&config->port[p];
		for(i=0;i<9;i++) {if(!values[i]) return false;v[i]=blobmsg_get_u32(values[i]);}
	}
	return qsdk_switch_valid(config);
}

static int rpc_luci_get_switch_settings(struct ubus_context *ctx,struct ubus_object *object,
	struct ubus_request_data *req,const char *method,struct blob_attr *message)
{
	struct qsdk_switch_config actual,saved;
	if(!rpc_luci_qsdk_switch_supported()) return UBUS_STATUS_NOT_SUPPORTED;
	if(!qsdk_switch_read(&actual)) return UBUS_STATUS_UNKNOWN_ERROR;
	blob_buf_init(&blob,0);void *table=blobmsg_open_table(&blob,"actual");qsdk_switch_reply(&blob,&actual);blobmsg_close_table(&blob,table);
	if(qsdk_switch_store(&saved,false) && qsdk_switch_valid(&saved)) {table=blobmsg_open_table(&blob,"saved");qsdk_switch_reply(&blob,&saved);blobmsg_close_table(&blob,table);}
	ubus_send_reply(ctx,req,blob.head);return UBUS_STATUS_OK;
}

static int rpc_luci_set_switch_settings(struct ubus_context *ctx,struct ubus_object *object,
	struct ubus_request_data *req,const char *method,struct blob_attr *message)
{
	struct qsdk_switch_config wanted,previous,actual;
	bool boot=!strcmp(method,"applySwitchSettings"), rollback=false;
	int error=UBUS_STATUS_UNKNOWN_ERROR, lock;
	if(!rpc_luci_qsdk_switch_supported()) return UBUS_STATUS_NOT_SUPPORTED;
	if(boot) {if(access("/etc/config/luci_qsdk_switch",F_OK)) return UBUS_STATUS_OK; if(!qsdk_switch_store(&wanted,false) || !qsdk_switch_valid(&wanted)) return UBUS_STATUS_INVALID_ARGUMENT;}
	else if(!qsdk_switch_parse(message,&wanted)) return UBUS_STATUS_INVALID_ARGUMENT;
	lock=open("/var/run/luci-ssdk.lock",O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
	if(lock<0 || flock(lock,LOCK_EX|LOCK_NB)) {if(lock>=0) close(lock);return UBUS_STATUS_UNKNOWN_ERROR;}
	if(!qsdk_switch_read(&actual)) goto out;
	if(!boot && qsdk_switch_store(&previous,false) && (!qsdk_switch_valid(&previous) || !qsdk_switch_matches(&actual,&previous))) goto out;
	previous=actual;
	if(!qsdk_switch_write(&wanted) || !qsdk_switch_read(&actual) || !qsdk_switch_matches(&actual,&wanted) || (!boot && !qsdk_switch_store(&wanted,true))) {
		rollback=qsdk_switch_write(&previous) && qsdk_switch_read(&actual) && qsdk_switch_matches(&actual,&previous);
		syslog(LOG_ERR,"QSDK switch apply failed; rollback %s",rollback?"verified":"FAILED");goto out;
	}
	blob_buf_init(&blob,0);qsdk_switch_reply(&blob,&actual);ubus_send_reply(ctx,req,blob.head);error=UBUS_STATUS_OK;
out:
	close(lock);return error;
}
