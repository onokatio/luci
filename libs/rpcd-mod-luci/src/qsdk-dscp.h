/* SPDX-License-Identifier: ISC */
static bool qsdk_dscp_get(const char *device, unsigned int dscp, unsigned int *tid)
{
	char index[8], text[1024], message[2048], identity[32], *line;
	const char *argv[] = { "/usr/sbin/cfg80211tool.1", "-i", device, "-f", "/lib/wifi/qcacommands_vap.xml", "-h", "none",
		"--START_CMD", "--g_dscp_tid_map", "--value0", index, "--RESPONSE", "--g_dscp_tid_map", "--END_CMD", NULL };
	pid_t pid = 0;
	unsigned int reported, value, lines = 0;
	int fd;
	ssize_t length;
	bool found = false;
	if (dscp > 63 || !qsdk_hostapd_ifname(device)) return false;
	fd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0) return false;
	/* This native getter logs its result instead of returning it over netlink. */
	if (lseek(fd, 0, SEEK_END) < 0) goto out;
	snprintf(index, sizeof(index), "%u", dscp << 2);
	if (!qsdk_exec_capture_pid(argv, text, sizeof(text), 150, true, &pid)) goto out;
	snprintf(identity, sizeof(identity), "[%ld:", (long)pid);
	while (lines++ < 128 && (length = read(fd, message, sizeof(message)-1)) > 0) {
		message[length] = 0;
		if (!(line = strstr(message, identity)) || !(line = strchr(line, ']'))) continue;
		if (sscanf(line+1, " 0x%x %u", &reported, &value) == 2 && reported == (dscp << 2) && value < 8) { *tid = value; found = true; }
	}
out:
	close(fd); return found;
}

static const struct blobmsg_policy qsdk_dscp_policy[] = {
	{ .name = "device", .type = BLOBMSG_TYPE_STRING },
	{ .name = "dscp", .type = BLOBMSG_TYPE_INT32 },
};

static int rpc_luci_get_wireless_dscp(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct blob_attr *tb[2];
	struct blob_buf result = {};
	void *table;
	const char *device;
	unsigned int start = 0, end = 63, tid, index;
	char key[8];
	int error = UBUS_STATUS_UNKNOWN_ERROR;
	int64_t deadline = qsdk_exec_millis()+4000;
	if (!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_dscp_policy, 2, tb, blob_data(message), blob_len(message));
	if (!tb[0] || !qsdk_hostapd_ifname(device = blobmsg_get_string(tb[0]))) return UBUS_STATUS_INVALID_ARGUMENT;
	if (tb[1]) { start = end = blobmsg_get_u32(tb[1]); if (start > 63) return UBUS_STATUS_INVALID_ARGUMENT; }
	blob_buf_init(&result, 0);
	table = blobmsg_open_table(&result, "map");
	for (index = start; index <= end; index++) {
		if (qsdk_exec_millis() >= deadline || !qsdk_dscp_get(device, index, &tid)) goto out;
		snprintf(key, sizeof(key), "%u", index); blobmsg_add_u32(&result, key, tid);
	}
	blobmsg_close_table(&result, table);
	ubus_send_reply(ctx, req, result.head); error = UBUS_STATUS_OK;
out:
	blob_buf_free(&result); return error;
}

static int rpc_luci_get_wireless_wmm(struct ubus_context *ctx,struct ubus_object *object,
	struct ubus_request_data *req,const char *method,struct blob_attr *message)
{
	struct blob_attr *tb[1];
	struct blob_buf result={};
	const char *device;
	char text[1024],parameter[4],category[4],scope[4],*number,*end;
	const char *names[]={"cwmin","cwmax","aifs","txop","acm","noack"},*categories[]={"BE","BK","VI","VO"};
	unsigned int p,c,s;
	int error=UBUS_STATUS_UNKNOWN_ERROR;
	int64_t deadline=qsdk_exec_millis()+2500;
	void *array,*entry;
	if(!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_wireless_policy,1,tb,blob_data(message),blob_len(message));
	if(!tb[0] || !qsdk_hostapd_ifname(device=blobmsg_get_string(tb[0]))) return UBUS_STATUS_INVALID_ARGUMENT;
	blob_buf_init(&result,0);array=blobmsg_open_array(&result,"parameters");
	for(s=0;s<2;s++) for(c=0;c<4;c++) for(p=1;p<=6;p++) {
		if(p==6 && s) continue;
		snprintf(parameter,sizeof(parameter),"%u",p);snprintf(category,sizeof(category),"%u",c);snprintf(scope,sizeof(scope),"%u",s);
		const char *argv[]={"/bin/sh","/usr/sbin/cfg80211tool",device,"getwmmparams",parameter,category,scope,NULL};
		if(qsdk_exec_millis()>=deadline || !qsdk_exec_capture(argv,text,sizeof(text),150,false) || !(number=strstr(text,"getwmmparams:"))) goto out;
		number+=13;errno=0;unsigned long value=strtoul(number,&end,10);
		if(errno || !isdigit((unsigned char)*number) || (*end && !isspace((unsigned char)*end)) || value>65535) goto out;
		entry=blobmsg_open_table(&result,NULL);blobmsg_add_string(&result,"parameter",names[p-1]);blobmsg_add_string(&result,"category",categories[c]);blobmsg_add_string(&result,"scope",s?"bss":"local");blobmsg_add_u32(&result,"value",value);blobmsg_close_table(&result,entry);
	}
	blobmsg_close_array(&result,array);ubus_send_reply(ctx,req,result.head);error=UBUS_STATUS_OK;
out:
	blob_buf_free(&result);return error;
}
