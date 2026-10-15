/* SPDX-License-Identifier: ISC */
#include <errno.h>
#include <sys/utsname.h>

static int qsdk_counter(const char *text, uint64_t *value)
{
	char *end;
	while (isspace((unsigned char)*text)) text++;
	if (!isdigit((unsigned char)*text)) return 0;
	errno = 0;
	*value = strtoull(text, &end, 10);
	if (errno) return 0;
	while (isspace((unsigned char)*end)) end++;
	return !*end;
}

static void qsdk_accel_counter(struct blob_buf *b, const char *key, const char *path)
{
	char text[128], decimal[32];
	uint64_t value;
	FILE *f = fopen(path, "r");
	if (!f) return;
	if (fgets(text, sizeof(text), f) && fgetc(f) == EOF && qsdk_counter(text, &value)) {
		/* Keep 64-bit counters exact in JavaScript. */
		snprintf(decimal, sizeof(decimal), "%llu", (unsigned long long)value);
		blobmsg_add_string(b, key, decimal);
	}
	fclose(f);
}

static int qsdk_accel_module(const char *name)
{
	char path[256];
	struct utsname u;
	if (uname(&u)) return 0;
	snprintf(path, sizeof(path), "/lib/modules/%s/%s.ko", u.release, name);
	return access(path, R_OK) == 0;
}

static void qsdk_accel_ppe(struct blob_buf *b)
{
	char line[256], key[64], decimal[32];
	unsigned lines = 0, bytes = 0;
	uint64_t value;
	void *group = NULL;
	FILE *f = fopen("/sys/kernel/debug/qca-nss-ppe/stats/common_stats", "r");
	if (!f) return;
	while (fgets(line, sizeof(line), f) && ++lines <= 512 && (bytes += strlen(line)) <= 32768) {
		if (!strcmp(line, "PPE stats:\n") || !strcmp(line, "PPE flow stats:\n") || !strcmp(line, "PPE tunnel stats:\n")) {
			if (group) blobmsg_close_table(b, group);
			group = blobmsg_open_table(b, !strcmp(line, "PPE stats:\n") ? "ppe" : !strcmp(line, "PPE flow stats:\n") ? "flows" : "tunnels");
		}
		char *start = strchr(line, '['), *end = strchr(line, ']');
		if (!group || !start || !end || end <= start || (size_t)(end - start - 1) >= sizeof(key) || end[1] != ':') continue;
		memcpy(key, start + 1, end - start - 1); key[end - start - 1] = 0;
		if (!*key || strspn(key, "abcdefghijklmnopqrstuvwxyz0123456789_") != strlen(key) || !qsdk_counter(end + 2, &value)) continue;
		snprintf(decimal, sizeof(decimal), "%llu", (unsigned long long)value);
		blobmsg_add_string(b, key, decimal);
	}
	if (group) blobmsg_close_table(b, group);
	fclose(f);
}

static int rpc_luci_get_acceleration_status(struct ubus_context *ctx, struct ubus_object *obj,
	struct ubus_request_data *req, const char *method, struct blob_attr *msg)
{
	static const char *engines[] = { "ppe", "sfe", "nss" };
	static const char *counters[] = { "accelerated_count", "tcp_accelerated_count", "udp_accelerated_count", "non_ported_accelerated_count", "pending_accel_count", "pending_decel_count" };
	char path[256], family_name[8], name[16];
	unsigned e, c, family;
	void *table, *engine, *protocol;
	blob_buf_init(&blob, 0);
	blobmsg_add_u8(&blob, "loaded", access("/sys/module/ecm", F_OK) == 0);
	table = blobmsg_open_table(&blob, "available");
	blobmsg_add_u8(&blob, "ppe", qsdk_accel_module("qca-nss-ppe"));
	blobmsg_add_u8(&blob, "sfe", qsdk_accel_module("qca-nss-sfe"));
	blobmsg_add_u8(&blob, "nss", qsdk_accel_module("qca-nss-drv"));
	blobmsg_close_table(&blob, table);
	qsdk_accel_counter(&blob, "connections", "/sys/kernel/debug/ecm/ecm_db/connection_count");
	qsdk_accel_counter(&blob, "ipv4_stop", "/sys/kernel/debug/ecm/front_end_ipv4_stop");
	qsdk_accel_counter(&blob, "ipv6_stop", "/sys/kernel/debug/ecm/front_end_ipv6_stop");
	table = blobmsg_open_table(&blob, "engines");
	for (e = 0; e < ARRAY_SIZE(engines); e++) {
		engine = blobmsg_open_table(&blob, engines[e]);
		for (family = 4; family <= 6; family += 2) {
			snprintf(family_name, sizeof(family_name), "ipv%u", family);
			protocol = blobmsg_open_table(&blob, family_name);
			for (c = 0; c < ARRAY_SIZE(counters); c++) {
				snprintf(path, sizeof(path), "/sys/kernel/debug/ecm/ecm_%s_ipv%u/%s", engines[e], family, counters[c]);
				qsdk_accel_counter(&blob, counters[c], path);
			}
			blobmsg_close_table(&blob, protocol);
		}
		blobmsg_close_table(&blob, engine);
	}
	blobmsg_close_table(&blob, table);
	qsdk_accel_ppe(&blob);
	table = blobmsg_open_table(&blob, "direct_switch");
	FILE *f = fopen("/sys/kernel/debug/qca-nss-ppe/ppe_ds/ppe_ds_node_stats", "r");
	if (f) {
		char line[128], decimal[32];
		unsigned lines = 0, node;
		uint64_t value;
		void *entry = NULL;
		while (fgets(line, sizeof(line), f) && ++lines <= 96) {
			if (!strncmp(line, "Node ", 5)) {
				if (entry) blobmsg_close_table(&blob, entry);
				entry = NULL;
				if (!qsdk_counter(line + 5, &value) || value >= 16) continue;
				node = value;
				snprintf(name, sizeof(name), "%u", node);
				entry = blobmsg_open_table(&blob, name);
			}
			else if (entry && (!strncmp(line, "Tx pkts ", 8) || !strncmp(line, "Rx pkts ", 8)) && qsdk_counter(line + 8, &value)) {
				snprintf(decimal, sizeof(decimal), "%llu", (unsigned long long)value);
				blobmsg_add_string(&blob, line[0] == 'T' ? "tx_packets" : "rx_packets", decimal);
			}
		}
		if (entry) blobmsg_close_table(&blob, entry);
		fclose(f);
	}
	blobmsg_close_table(&blob, table);
	ubus_send_reply(ctx, req, blob.head);
	return UBUS_STATUS_OK;
}
