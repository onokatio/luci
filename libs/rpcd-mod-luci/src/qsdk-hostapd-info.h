/* SPDX-License-Identifier: ISC */
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>
static bool qsdk_hostapd_field(const char *text, const char *key, char *value, size_t size)
{
	size_t length = strlen(key), n;
	const char *line = text, *end;
	while (*line) {
		end = strchr(line, '\n');
		if (!end) end = line + strlen(line);
		if ((size_t)(end-line) > length && !strncmp(line, key, length) && line[length] == '=') {
			n = end-line-length-1;
			if (n >= size) return false;
			memcpy(value, line+length+1, n); value[n] = 0; return true;
		}
		line = *end ? end+1 : end;
	}
	return false;
}

static bool qsdk_hostapd_unsigned(const char *text, const char *key, uint64_t *number)
{
	char value[32], *end;
	if (!qsdk_hostapd_field(text, key, value, sizeof(value)) || !isdigit((unsigned char)value[0])) return false;
	errno = 0; *number = strtoull(value, &end, 10);
	return !errno && !*end;
}

static void qsdk_hostapd_number(struct blob_buf *result, const char *text, const char *key, const char *name)
{
	uint64_t value;
	if (qsdk_hostapd_unsigned(text, key, &value)) blobmsg_add_u64(result, name, value);
}

static bool qsdk_hostapd_parent(const char *name, char parent[6])
{
	char path[128], value[16];
	FILE *file;
	if (!name || !qsdk_hostapd_ifname(name)) return false;
	snprintf(path, sizeof(path), "/sys/class/net/%.15s/parent", name);
	if (!(file = fopen(path, "r"))) return false;
	if (fscanf(file, "%15s", value) != 1) { fclose(file); return false; }
	fclose(file);
	if (strcmp(value, "wifi0") && strcmp(value, "wifi1") && strcmp(value, "wifi2")) return false;
	strcpy(parent, value); return true;
}

static int qsdk_hostapd_info(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct qsdk_hostapd_vif *vif = container_of(object, struct qsdk_hostapd_vif, object);
	struct blob_buf result = {};
	char status[8192], text[16384], value[256], mac[18], previous[18] = "", command[64];
	void *clients, *entry, *table;
	unsigned int count;
	char parent[6];
	int error = UBUS_STATUS_UNKNOWN_ERROR;
	if (qsdk_hostapd_request(vif->path, "STATUS", status, sizeof(status)) < 0 || !strncmp(status, "FAIL", 4)) return error;
	blob_buf_init(&result, 0);
	if (!strcmp(method, "get_features")) {
		char path[128], modes[2048];
		FILE *file;
		const char *tokens[] = { "11N", "11AC", "11AX", "11BE" };
		const char *names[] = { "ht_supported", "vht_supported", "he_supported", "eht_supported" };
		if (!qsdk_hostapd_parent(vif->name + sizeof("hostapd.") - 1, parent)) goto out;
		snprintf(path, sizeof(path), "/sys/class/net/%s/hwmodes", parent);
		if (!(file = fopen(path, "r"))) goto out;
		if (!fgets(modes, sizeof(modes), file)) { fclose(file); goto out; }
		fclose(file);
		for (count = 0; count < 4; count++) blobmsg_add_u8(&result, names[count], strstr(modes, tokens[count]) != NULL);
	} else if (!strcmp(method, "get_status")) {
		const char *keys[] = { "state", "bssid[0]", "ssid[0]" };
		const char *names[] = { "status", "bssid", "ssid" };
		for (count = 0; count < 3; count++)
			if (qsdk_hostapd_field(status, keys[count], value, sizeof(value))) blobmsg_add_string(&result, names[count], value);
		if (qsdk_hostapd_parent(vif->name + sizeof("hostapd.") - 1, parent)) blobmsg_add_string(&result, "phy", parent);
		qsdk_hostapd_number(&result, status, "freq", "freq");
		qsdk_hostapd_number(&result, status, "channel", "channel");
		qsdk_hostapd_number(&result, status, "beacon_int", "beacon_interval");
		qsdk_hostapd_number(&result, status, "dtim_period", "dtim_period");
		qsdk_hostapd_number(&result, status, "num_sta[0]", "num_sta");
		table = blobmsg_open_table(&result, "dfs");
		qsdk_hostapd_number(&result, status, "cac_time_seconds", "cac_seconds");
		qsdk_hostapd_number(&result, status, "cac_time_left_seconds", "cac_seconds_left");
		if (qsdk_hostapd_field(status, "state", value, sizeof(value))) blobmsg_add_u8(&result, "cac_active", !strcmp(value, "DFS"));
		blobmsg_close_table(&result, table);
	} else {
		qsdk_hostapd_number(&result, status, "freq", "freq");
		clients = blobmsg_open_table(&result, "clients");
		strcpy(command, "STA-FIRST");
		for (count = 0; count < 128; count++) {
			if (qsdk_hostapd_request(vif->path, command, text, sizeof(text)) < 0) goto out;
			if (!*text || !strncmp(text, "FAIL", 4)) break;
			if (sscanf(text, "%17s", mac) != 1 || !isspace((unsigned char)text[17]) || !qsdk_hostapd_mac(mac) || !strcasecmp(previous, mac)) goto out;
			strcpy(previous, mac);
			entry = blobmsg_open_table(&result, mac);
			if (qsdk_hostapd_field(text, "flags", value, sizeof(value))) {
				const char *flags[] = { "[AUTH]", "[ASSOC]", "[AUTHORIZED]", "[PREAUTH]", "[WDS]", "[WMM]", "[HT]", "[VHT]", "[HE]", "[EHT]", "[WPS]", "[MFP]" };
				const char *names[] = { "auth", "assoc", "authorized", "preauth", "wds", "wmm", "ht", "vht", "he", "eht", "wps", "mfp" };
				unsigned int i;
				for (i = 0; i < 12; i++) blobmsg_add_u8(&result, names[i], strstr(value, flags[i]) != NULL);
			}
			qsdk_hostapd_number(&result, text, "aid", "aid");
			qsdk_hostapd_number(&result, text, "connected_time", "connected_time");
			table = blobmsg_open_table(&result, "bytes");
			qsdk_hostapd_number(&result, text, "rx_bytes", "rx"); qsdk_hostapd_number(&result, text, "tx_bytes", "tx");
			blobmsg_close_table(&result, table);
			table = blobmsg_open_table(&result, "packets");
			qsdk_hostapd_number(&result, text, "rx_packets", "rx"); qsdk_hostapd_number(&result, text, "tx_packets", "tx");
			blobmsg_close_table(&result, table);
			blobmsg_close_table(&result, entry);
			snprintf(command, sizeof(command), "STA-NEXT %s", mac);
		}
		if (count == 128 && (qsdk_hostapd_request(vif->path, command, text, sizeof(text)) < 0 || (*text && strncmp(text, "FAIL", 4)))) goto out;
		blobmsg_close_table(&result, clients);
	}
	ubus_send_reply(ctx, req, result.head); error = UBUS_STATUS_OK;
out:
	blob_buf_free(&result);
	return error;
}
