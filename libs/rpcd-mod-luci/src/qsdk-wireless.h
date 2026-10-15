/* SPDX-License-Identifier: ISC */
#include "qsdk-exec.h"

static const struct blobmsg_policy qsdk_wireless_policy[] = {
	{ .name = "device", .type = BLOBMSG_TYPE_STRING },
};

static bool qsdk_wireless_get(const char *device, const char *getter, int64_t *value)
{
	char text[1024], prefix[64], *number, *end;
	const char *argv[] = { "/bin/sh", "/usr/sbin/cfg80211tool", device, getter, NULL };
	if (!qsdk_exec_capture(argv, text, sizeof(text), 150, false)) return false;
	snprintf(prefix, sizeof(prefix), "%s:", getter);
	if (!(number = strstr(text, prefix))) return false;
	number += strlen(prefix);
	if (!isdigit((unsigned char)*number) && *number != '-') return false;
	errno = 0; *value = strtoll(number, &end, 10);
	return !errno && end != number && (!*end || isspace((unsigned char)*end));
}

static int rpc_luci_get_wireless_settings(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	static const char *const getters[][2] = {
		{ "he_dl_ofdma", "get_he_dl_ofdma" }, { "he_ul_ofdma", "get_he_ul_ofdma" },
		{ "he_ul_mimo", "get_he_ul_mimo" }, { "he_mubfer", "g_he_mubfer" },
		{ "he_subfer", "g_he_subfer" }, { "vhtmubfer", "get_vhtmubfer" }, { "vhtsubfer", "get_vhtsubfer" }, { "twt_responder", "get_twt_responder" },
		{ "mcastenhance", "g_mcastenhance" },
		{ "maxsta", "get_maxsta" }, { "commitatf", "get_commitatf" }, { "atfssidgroup", "g_atfssidgroup" }, { "dscp_override", "get_dscp_ovride" }, { "atfstrictsched", "gatfstrictsched" },
		{ "rrm", "get_rrm" }, { "wnm", "get_wnm" },
		{ "set_eht_ulofdma", "get_eht_ulofdma" }, { "set_eht_ulmumimo", "get_eht_ulmumimo" },
	};
	struct blob_attr *tb[1];
	char text[32768], path[128], prefix[64], *number, *end;
	const char *device;
	void *values;
	unsigned long value;
	unsigned int i;
	int64_t deadline = qsdk_exec_millis()+2000;
	if (!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_wireless_policy, 1, tb, blob_data(message), blob_len(message));
	if (!tb[0]) return UBUS_STATUS_INVALID_ARGUMENT;
	device = blobmsg_get_string(tb[0]);
	if (!qsdk_hostapd_ifname(device) && strcmp(device, "wifi0") && strcmp(device, "wifi1") && strcmp(device, "wifi2")) return UBUS_STATUS_INVALID_ARGUMENT;
	snprintf(path, sizeof(path), "/sys/class/net/%s", device);
	if (access(path, F_OK)) return UBUS_STATUS_NOT_FOUND;
	blob_buf_init(&blob, 0);
	blobmsg_add_string(&blob, "device", device);
	values = blobmsg_open_table(&blob, "values");
	for (i = 0; i < ARRAY_SIZE(getters) && qsdk_exec_millis() < deadline; i++) {
		/* The native wrapper has no shebang; invoke the shell explicitly. */
		const char *argv[] = { "/bin/sh", "/usr/sbin/cfg80211tool", device, getters[i][1], NULL };
		if (!qsdk_exec_capture(argv, text, sizeof(text), 100, false)) continue;
		snprintf(prefix, sizeof(prefix), "%s:", getters[i][1]);
		if (!(number = strstr(text, prefix))) continue;
		number += strlen(prefix);
		if (!isdigit((unsigned char)*number)) continue;
		errno = 0; value = strtoul(number, &end, 10);
		if (errno || value > UINT32_MAX || (*end && !isspace((unsigned char)*end))) continue;
		blobmsg_add_u32(&blob, getters[i][0], value);
	}
	blobmsg_close_table(&blob, values);
	if (qsdk_hostapd_ifname(device) && qsdk_exec_millis() < deadline) {
		const char *argv[] = { "/usr/sbin/wlanconfig", device, "showatftable", "-cfg80211", NULL };
		if (qsdk_exec_capture(argv, text, sizeof(text), 250, true)) blobmsg_add_string(&blob, "airtime", text);
		const char *commands[]={"showatfgroup","showatfsubgroup"};
		for(i=0;i<2 && qsdk_exec_millis()<deadline;i++) {
			const char *command[]={"/usr/sbin/wlanconfig",device,commands[i],"-cfg80211",NULL};
			if(qsdk_exec_capture(command,text,sizeof(text),250,true)) blobmsg_add_string(&blob,commands[i],text);
		}
	}
	ubus_send_reply(ctx, req, blob.head);
	return UBUS_STATUS_OK;
}
