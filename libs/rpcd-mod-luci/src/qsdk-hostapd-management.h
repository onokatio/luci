/* SPDX-License-Identifier: ISC */
/* Keep the standard hostapd API while using the vendor control socket. */
static int qsdk_hostapd_hex(const char *value, size_t min, size_t max)
{
	size_t n = value ? strlen(value) : 0;
	return n >= min && n <= max && !(n & 1) && strspn(value, "0123456789abcdefABCDEF") == n;
}

static int qsdk_hostapd_wps(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct qsdk_hostapd_vif *vif = container_of(object, struct qsdk_hostapd_vif, object);
	struct blob_buf result = {};
	char reply[1024], *line, *save, *value;
	const char *command = !strcmp(method, "wps_start") ? "WPS_PBC" :
		!strcmp(method, "wps_cancel") ? "WPS_CANCEL" : "WPS_GET_STATUS";
	if (strcmp(method, "wps_status"))
		return qsdk_hostapd_ok(vif->path, command) ? UBUS_STATUS_OK : UBUS_STATUS_UNKNOWN_ERROR;
	if (qsdk_hostapd_request(vif->path, command, reply, sizeof(reply)) < 0 ||
	    !strncmp(reply, "FAIL", 4) || !strncmp(reply, "UNKNOWN", 7)) return UBUS_STATUS_NOT_SUPPORTED;
	blob_buf_init(&result, 0);
	for (line = strtok_r(reply, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
		if (!(value = strstr(line, ": "))) continue;
		value += 2;
		if (!strncmp(line, "PBC Status:", 11)) blobmsg_add_string(&result, "pbc_status", value);
		else if (!strncmp(line, "Last WPS result:", 16)) blobmsg_add_string(&result, "last_wps_result", value);
		else if (!strncmp(line, "Peer Address:", 13) && qsdk_hostapd_mac(value)) blobmsg_add_string(&result, "peer_address", value);
	}
	ubus_send_reply(ctx, req, result.head);
	blob_buf_free(&result);
	return UBUS_STATUS_OK;
}

enum { QM_ADDR, QM_NEIGHBORS, QM_DISASSOC, QM_TIMER, QM_VALIDITY, QM_ABRIDGED, QM_TOKEN,
	QM_MODE, QM_OPCLASS, QM_CHANNEL, QM_DURATION, QM_BSSID, QM_SSID, QM_COUNT };
static const struct blobmsg_policy qsdk_management_policy[QM_COUNT] = {
	[QM_ADDR] = { .name = "addr", .type = BLOBMSG_TYPE_STRING },
	[QM_NEIGHBORS] = { .name = "neighbors", .type = BLOBMSG_TYPE_ARRAY },
	[QM_DISASSOC] = { .name = "disassociation_imminent", .type = BLOBMSG_TYPE_BOOL },
	[QM_TIMER] = { .name = "disassociation_timer", .type = BLOBMSG_TYPE_INT32 },
	[QM_VALIDITY] = { .name = "validity_period", .type = BLOBMSG_TYPE_INT32 },
	[QM_ABRIDGED] = { .name = "abridged", .type = BLOBMSG_TYPE_BOOL },
	[QM_TOKEN] = { .name = "dialog_token", .type = BLOBMSG_TYPE_INT32 },
	[QM_MODE] = { .name = "mode", .type = BLOBMSG_TYPE_INT32 },
	[QM_OPCLASS] = { .name = "op_class", .type = BLOBMSG_TYPE_INT32 },
	[QM_CHANNEL] = { .name = "channel", .type = BLOBMSG_TYPE_INT32 },
	[QM_DURATION] = { .name = "duration", .type = BLOBMSG_TYPE_INT32 },
	[QM_BSSID] = { .name = "bssid", .type = BLOBMSG_TYPE_STRING },
	[QM_SSID] = { .name = "ssid", .type = BLOBMSG_TYPE_STRING },
};

static unsigned int qsdk_hostapd_byte(const char *hex)
{
	char value[3] = { hex[0], hex[1], 0 };
	return strtoul(value, NULL, 16);
}

static int qsdk_hostapd_report(const char *hex)
{
	size_t position = 26, length;
	if (!qsdk_hostapd_hex(hex, 26, 510)) return 0;
	length = strlen(hex);
	while (position < length) {
		if (length-position < 4) return 0;
		position += 4 + 2*qsdk_hostapd_byte(hex+position+2);
		if (position > length) return 0;
	}
	return 1;
}

static int qsdk_hostapd_transition(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct qsdk_hostapd_vif *vif = container_of(object, struct qsdk_hostapd_vif, object);
	struct blob_attr *tb[QM_COUNT], *item;
	char command[4096], mac[18], reply[64];
	const char *hex, *addr;
	unsigned int timer = 0, validity = 30, token = 1, mode = 0, count = 0, info;
	int rem, n, used;
	if (!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_management_policy, QM_COUNT, tb, blob_data(message), blob_len(message));
	if (!tb[QM_ADDR] || !qsdk_hostapd_mac(addr = blobmsg_get_string(tb[QM_ADDR]))) return UBUS_STATUS_INVALID_ARGUMENT;
	if (tb[QM_TIMER]) timer = blobmsg_get_u32(tb[QM_TIMER]);
	if (tb[QM_VALIDITY]) validity = blobmsg_get_u32(tb[QM_VALIDITY]);
	if (tb[QM_TOKEN]) token = blobmsg_get_u32(tb[QM_TOKEN]);
	if (tb[QM_MODE]) mode = blobmsg_get_u32(tb[QM_MODE]);
	if (timer > 65535 || !validity || validity > 255 || !token || token > 255 || mode > 255) return UBUS_STATUS_INVALID_ARGUMENT;
	if (!strcmp(method, "rrm_beacon_req")) {
		const char *bssid = tb[QM_BSSID] ? blobmsg_get_string(tb[QM_BSSID]) : "ff:ff:ff:ff:ff:ff";
		const char *ssid = tb[QM_SSID] ? blobmsg_get_string(tb[QM_SSID]) : NULL;
		unsigned int opclass, channel, duration;
		size_t i, len = ssid ? strlen(ssid) : 0;
		char bssidhex[13];
		if (!tb[QM_OPCLASS] || !tb[QM_CHANNEL] || !tb[QM_DURATION] || !tb[QM_MODE] ||
		    mode > 2 || len > 32 || (strcasecmp(bssid, "ff:ff:ff:ff:ff:ff") && !qsdk_hostapd_mac(bssid))) return UBUS_STATUS_INVALID_ARGUMENT;
		opclass = blobmsg_get_u32(tb[QM_OPCLASS]); channel = blobmsg_get_u32(tb[QM_CHANNEL]); duration = blobmsg_get_u32(tb[QM_DURATION]);
		if (!opclass || opclass > 255 || channel > 255 || duration > 65535) return UBUS_STATUS_INVALID_ARGUMENT;
		for (i = 0; i < 6; i++) { bssidhex[2*i] = bssid[3*i]; bssidhex[2*i+1] = bssid[3*i+1]; }
		bssidhex[12] = 0;
		used = snprintf(command, sizeof(command), "REQ_BEACON %s %02x%02x0000%02x%02x%02x%s",
			addr, opclass, channel, duration & 255, duration >> 8, mode, bssidhex);
		if (ssid) {
			used += snprintf(command+used, sizeof(command)-used, "00%02x", (unsigned int)len);
			for (i = 0; i < len; i++) used += snprintf(command+used, sizeof(command)-used, "%02x", (unsigned char)ssid[i]);
		}
		if (qsdk_hostapd_request(vif->path, command, reply, sizeof(reply)) < 0 ||
		    !strncmp(reply, "FAIL", 4) || !strncmp(reply, "UNKNOWN", 7)) return UBUS_STATUS_UNKNOWN_ERROR;
		return UBUS_STATUS_OK;
	}
	used = snprintf(command, sizeof(command), "BSS_TM_REQ %s disassoc_imminent=%u disassoc_timer=%u valid_int=%u dialog_token=%u abridged=%u",
		addr, tb[QM_DISASSOC] && blobmsg_get_bool(tb[QM_DISASSOC]), timer, validity, token,
		tb[QM_ABRIDGED] && blobmsg_get_bool(tb[QM_ABRIDGED]));
	if (tb[QM_NEIGHBORS]) blobmsg_for_each_attr(item, tb[QM_NEIGHBORS], rem) {
		if (++count > 8 || blobmsg_type(item) != BLOBMSG_TYPE_STRING ||
		    !qsdk_hostapd_report(hex = blobmsg_get_string(item))) return UBUS_STATUS_INVALID_ARGUMENT;
		snprintf(mac, sizeof(mac), "%.2s:%.2s:%.2s:%.2s:%.2s:%.2s", hex, hex+2, hex+4, hex+6, hex+8, hex+10);
		if (!qsdk_hostapd_mac(mac)) return UBUS_STATUS_INVALID_ARGUMENT;
		info = qsdk_hostapd_byte(hex+12) | qsdk_hostapd_byte(hex+14) << 8 |
			qsdk_hostapd_byte(hex+16) << 16 | qsdk_hostapd_byte(hex+18) << 24;
		n = snprintf(command+used, sizeof(command)-used, " neighbor=%s,0x%x,%u,%u,%u%s%s",
			mac, info, qsdk_hostapd_byte(hex+20), qsdk_hostapd_byte(hex+22), qsdk_hostapd_byte(hex+24),
			hex[26] ? "," : "", hex+26);
		if (n < 0 || n >= (int)sizeof(command)-used) return UBUS_STATUS_INVALID_ARGUMENT;
		used += n;
	}
	if (count) {
		n = snprintf(command+used, sizeof(command)-used, " pref=1");
		if (n < 0 || n >= (int)sizeof(command)-used) return UBUS_STATUS_INVALID_ARGUMENT;
	}
	return qsdk_hostapd_ok(vif->path, command) ? UBUS_STATUS_OK : UBUS_STATUS_UNKNOWN_ERROR;
}

enum { QN_BSSID, QN_SSID, QN_REPORT, QN_COUNT };
static const struct blobmsg_policy qsdk_neighbor_policy[QN_COUNT] = {
	[QN_BSSID] = { .name = "bssid", .type = BLOBMSG_TYPE_STRING },
	[QN_SSID] = { .name = "ssid", .type = BLOBMSG_TYPE_STRING },
	[QN_REPORT] = { .name = "report", .type = BLOBMSG_TYPE_STRING },
};

static int qsdk_hostapd_neighbor(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct qsdk_hostapd_vif *vif = container_of(object, struct qsdk_hostapd_vif, object);
	struct blob_buf result = {};
	struct blob_attr *tb[QN_COUNT];
	char command[1024], reply[8192], ssidhex[65], decoded[33], nr[511], bssid[18], own[18] = "", *line, *save;
	void *list, *entry;
	const char *mac, *ssid, *report;
	size_t i, len;
	if (!strcmp(method, "rrm_nr_list")) {
		const char *ifname = strrchr(vif->path, '/');
		if (ifname && qsdk_hostapd_ifname(ifname+1)) {
			FILE *file;
			snprintf(command, sizeof(command), "/sys/class/net/%s/address", ifname+1);
			if ((file = fopen(command, "r"))) { if (fscanf(file, "%17s", own) != 1) own[0] = 0; fclose(file); }
		}
		if (qsdk_hostapd_request(vif->path, "SHOW_NEIGHBOR", reply, sizeof(reply)) < 0 ||
		    !strncmp(reply, "UNKNOWN", 7)) return UBUS_STATUS_NOT_SUPPORTED;
		blob_buf_init(&result, 0);
		list = blobmsg_open_array(&result, "list");
		for (line = strtok_r(reply, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
			if (sscanf(line, "%17s ssid=%64s nr=%510s", bssid, ssidhex, nr) != 3 ||
			    !qsdk_hostapd_mac(bssid) || !qsdk_hostapd_hex(ssidhex, 2, 64) || !qsdk_hostapd_hex(nr, 26, 510)) continue;
			if (!strcasecmp(bssid, own)) continue;
			len = strlen(ssidhex)/2;
			for (i = 0; i < len; i++) decoded[i] = qsdk_hostapd_byte(ssidhex+2*i);
			decoded[len] = 0;
			if (strlen(decoded) != len) continue;
			entry = blobmsg_open_array(&result, NULL);
			blobmsg_add_string(&result, NULL, bssid);
			blobmsg_add_string(&result, NULL, decoded);
			blobmsg_add_string(&result, NULL, nr);
			blobmsg_close_array(&result, entry);
		}
		blobmsg_close_array(&result, list);
		ubus_send_reply(ctx, req, result.head);
		blob_buf_free(&result);
		return UBUS_STATUS_OK;
	}
	if (!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_neighbor_policy, QN_COUNT, tb, blob_data(message), blob_len(message));
	if (!tb[QN_BSSID] || !qsdk_hostapd_mac(mac = blobmsg_get_string(tb[QN_BSSID])) || !tb[QN_SSID]) return UBUS_STATUS_INVALID_ARGUMENT;
	ssid = blobmsg_get_string(tb[QN_SSID]);
	len = strlen(ssid);
	if (!len || len > 32 || strpbrk(ssid, "\r\n")) return UBUS_STATUS_INVALID_ARGUMENT;
	for (i = 0; i < len; i++) snprintf(ssidhex+2*i, 3, "%02x", (unsigned char)ssid[i]);
	if (!strcmp(method, "qsdk_rrm_nr_remove")) snprintf(command, sizeof(command), "REMOVE_NEIGHBOR %s ssid=%s", mac, ssidhex);
	else {
		if (!tb[QN_REPORT] || !qsdk_hostapd_report(report = blobmsg_get_string(tb[QN_REPORT]))) return UBUS_STATUS_INVALID_ARGUMENT;
		snprintf(bssid, sizeof(bssid), "%.2s:%.2s:%.2s:%.2s:%.2s:%.2s", report, report+2, report+4, report+6, report+8, report+10);
		if (strcasecmp(bssid, mac)) return UBUS_STATUS_INVALID_ARGUMENT;
		snprintf(command, sizeof(command), "SET_NEIGHBOR %s ssid=%s nr=%s", mac, ssidhex, report);
	}
	return qsdk_hostapd_ok(vif->path, command) ? UBUS_STATUS_OK : UBUS_STATUS_UNKNOWN_ERROR;
}
