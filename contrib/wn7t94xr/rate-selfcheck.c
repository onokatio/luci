#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <errno.h>
#include <stdbool.h>
#include <string.h>
#include "qsdk-hostapd-control.h"
#include "qsdk-telemetry.h"
#include <libubox/blobmsg_json.h>
#include <iwinfo.h>
static struct blob_buf buf;
#include "qsdk-rate.inc"

int main(void)
{
	struct qsdk_station_info station;
	char response[] = "flags=[AUTH][ASSOC][AUTHORIZED][WMM][MFP]\nrx_bytes=4294967297\ntx_bytes=18446744073709551615\n";
	char invalid[] = "rx_bytes=-1\ntx_bytes=18446744073709551616\n";
	memset(&station, 0, sizeof(station));
	rpc_iwinfo_qsdk_station_parse(response, &station);
	assert(station.flags && station.authorized && station.authenticated && station.wme && station.mfp);
	assert(station.has_rx_bytes && station.rx_bytes == 4294967297ULL);
	assert(station.has_tx_bytes && station.tx_bytes == UINT64_MAX);
	memset(&station, 0, sizeof(station));
	rpc_iwinfo_qsdk_station_parse(invalid, &station);
	assert(!station.flags && !station.has_rx_bytes && !station.has_tx_bytes);
	rpc_iwinfo_qsdk_station("ath1;id", "00:11:22:33:44:55", &station);
	assert(!station.flags);
	struct iwinfo_rate_entry rate = { .rate = 5764800, .mcs = -1, .is_eht = 1, .is_320mhz = 1, .nss = 2 };
	struct blob_attr *tb[4];
	const struct blobmsg_policy policy[] = {
		{ .name = "mhz", .type = BLOBMSG_TYPE_INT32 },
		{ .name = "eht", .type = BLOBMSG_TYPE_BOOL },
		{ .name = "mcs", .type = BLOBMSG_TYPE_INT32 },
		{ .name = "nss", .type = BLOBMSG_TYPE_INT32 },
	};
	blob_buf_init(&buf, 0);
	rpc_iwinfo_add_rateinfo(&rate);
	blobmsg_parse(policy, 4, tb, blob_data(buf.head), blob_len(buf.head));
	assert(tb[0] && blobmsg_get_u32(tb[0]) == 320);
	assert(tb[1] && blobmsg_get_bool(tb[1]));
	assert(!tb[2] && tb[3] && blobmsg_get_u32(tb[3]) == 2);
	blob_buf_free(&buf);
	struct qsdk_telemetry telemetry;
	assert(!qsdk_telemetry_read("ath1;id", "00:11:22:33:44:55", &telemetry));
	telemetry.rx.has_mcs = true;
	telemetry.rx.modes[2].mcs[11] = 42;
	telemetry.rx.has_gi = true;
	telemetry.rx.gi[2] = 24;
	blob_buf_init(&buf, 0);
	rpc_iwinfo_add_usage(&telemetry.rx);
	const struct blobmsg_policy usage_policy[] = {
		{ .name = "mcs_usage", .type = BLOBMSG_TYPE_TABLE },
		{ .name = "gi_usage", .type = BLOBMSG_TYPE_ARRAY },
	};
	const struct blobmsg_policy he_policy = { .name = "he", .type = BLOBMSG_TYPE_ARRAY };
	struct blob_attr *usage[2], *arrays[2], *item;
	int remaining, index, field;
	blobmsg_parse(usage_policy, 2, usage, blob_data(buf.head), blob_len(buf.head));
	assert(usage[0] && usage[1]);
	blobmsg_parse(&he_policy, 1, arrays, blobmsg_data(usage[0]), blobmsg_data_len(usage[0]));
	arrays[1] = usage[1];
	assert(arrays[0]);
	for (field = 0; field < 2; field++) {
		index = 0;
		blobmsg_for_each_attr(item, arrays[field], remaining) {
			assert(blobmsg_type(item) == BLOBMSG_TYPE_INT32);
			assert(blobmsg_get_u32(item) == (index == (field ? 2 : 11) ? (field ? 24 : 42) : 0));
			index++;
		}
		assert(index == (field ? QSDK_GI_COUNT : QSDK_MCS_COUNT));
	}
	blob_buf_free(&buf);
	puts("QSDK rate selfcheck passed: 320 MHz, NSS, and unknown MCS");
	return 0;
}
