/* SPDX-License-Identifier: ISC */
static void qsdk_wireless_counter(struct blob_buf *result, const char *name, unsigned long long value)
{
	char number[32];
	snprintf(number, sizeof(number), "%llu", value);
	blobmsg_add_string(result, name, number);
}

static int rpc_luci_get_wireless_diagnostics(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct blob_attr *tb[1];
	const char *device;
	struct blob_buf result = {};
	char text[32768], *line, *save, band[16], timestamp[96], parent[6];
	unsigned int channel, frequency, i;
	unsigned long long own, total, tx, rx, busy, extension;
	int64_t value;
	void *table, *entry;
	bool scanning = false;
	static const char *getters[][2] = {
		{ "noise", "get_channf" }, { "channel_utilization", "get_chutil" },
		{ "acs_state", "get_acs_state" }, { "cac_state", "get_cac_state" },
		{ "puncture_bitmap", "get_puncture_bitmap" }, { "he_mu_edca", "get_he_mu_edca" },
	};
	if (!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_wireless_policy, 1, tb, blob_data(message), blob_len(message));
	if (!tb[0] || !qsdk_hostapd_ifname(device = blobmsg_get_string(tb[0]))) return UBUS_STATUS_INVALID_ARGUMENT;
	blob_buf_init(&result, 0);
	blobmsg_add_string(&result, "device", device);
	for (i = 0; i < ARRAY_SIZE(getters); i++)
		if (qsdk_wireless_get(device, getters[i][1], &value)) blobmsg_add_double(&result, getters[i][0], (double)value);
	if(qsdk_hostapd_parent(device,parent)) {
		const char *radio_getters[][2]={{"dfs_puncture","g_dfs_puncture_en"},{"puncture_strict","g_puncture_strict"},{"atf_strict","gatfstrictsched"}};
		for(i=0;i<ARRAY_SIZE(radio_getters);i++)
			if(qsdk_wireless_get(parent,radio_getters[i][1],&value)) blobmsg_add_double(&result,radio_getters[i][0],(double)value);
	}
	const char *survey[] = { "/usr/sbin/wifitool", device, "get_chan_survey", NULL };
	if (qsdk_exec_capture(survey, text, sizeof(text), 500, true)) {
		table = blobmsg_open_array(&result, "survey");
		for (line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
			if (strstr(line, "Scan channel")) scanning = true;
			if (sscanf(line, "channel: %u, freq: %u, rx_bss: %llu, total: %llu, tx: %llu, rx: %llu, busy: %llu, busy_ext: %llu",
			    &channel, &frequency, &own, &total, &tx, &rx, &busy, &extension) != 8 ||
			    !channel || channel > 233 || frequency < 2400 || frequency > 7125 || busy > total) continue;
			entry = blobmsg_open_table(&result, NULL);
			blobmsg_add_u32(&result, "channel", channel); blobmsg_add_u32(&result, "frequency", frequency);
			blobmsg_add_u8(&result, "scan", scanning);
			qsdk_wireless_counter(&result, "total", total); qsdk_wireless_counter(&result, "busy", busy);
			qsdk_wireless_counter(&result, "rx", rx); qsdk_wireless_counter(&result, "tx", tx);
			qsdk_wireless_counter(&result, "rx_bss", own); qsdk_wireless_counter(&result, "busy_ext", extension);
			blobmsg_close_table(&result, entry);
		}
		blobmsg_close_array(&result, table);
	}
	const char *history[] = { "/usr/sbin/wifitool", device, "tr069_chanhist", NULL };
	if (qsdk_exec_capture(history, text, sizeof(text), 300, true)) {
		table = blobmsg_open_array(&result, "history");
		for (line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
			if (sscanf(line, " %u %15s %95[^\n]", &channel, band, timestamp) != 3 || !channel || channel > 233) continue;
			entry = blobmsg_open_table(&result, NULL);
			blobmsg_add_u32(&result, "channel", channel); blobmsg_add_string(&result, "band", band);
			blobmsg_add_string(&result, "time", timestamp); blobmsg_close_table(&result, entry);
		}
		blobmsg_close_array(&result, table);
	}
	ubus_send_reply(ctx, req, result.head); blob_buf_free(&result);
	return UBUS_STATUS_OK;
}
