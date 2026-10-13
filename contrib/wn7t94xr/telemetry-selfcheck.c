/* Test-only ABI probe; never included in an IPK. */
#include <assert.h>
#include "qsdk-hostapd-control.h"
#include "qsdk-telemetry.h"

static void print_usage(const struct qsdk_usage *usage)
{
	const char *modes[] = { "ht", "vht", "he", "eht" };
	int mode, i;
	printf("{\"has_mcs\":%s,\"has_gi\":%s,\"gi_usage\":[", usage->has_mcs ? "true" : "false", usage->has_gi ? "true" : "false");
	for (i = 0; i < QSDK_GI_COUNT; i++) printf("%s%u", i ? "," : "", usage->gi[i]);
	printf("],\"mcs_usage\":{");
	for (mode = 0; mode < 4; mode++) {
		printf("%s\"%s\":[", mode ? "," : "", modes[mode]);
		for (i = 0; i < QSDK_MCS_COUNT; i++) printf("%s%u", i ? "," : "", usage->modes[mode].mcs[i]);
		printf("]");
	}
	printf("}}");
}

int main(int argc, char **argv)
{
	struct qsdk_telemetry result;
	assert(qsdk_hostapd_request("", "", NULL, 1) == -1);
	if (argc == 3) {
		bool available = qsdk_telemetry_read(argv[1], argv[2], &result);
		printf("{\"available\":%s,\"rx\":", available ? "true" : "false");
		print_usage(&result.rx);
		printf(",\"tx\":");
		print_usage(&result.tx);
		puts("}");
		return available ? 0 : 1;
	}
	assert(argc == 1);
	uint8_t mac[6] = { 0, 0x11, 0x22, 0x33, 0x44, 0x55 };
	struct qsdk_advance_tx tx = { .gi = { 10, 0, 3, 0, 1 } };
	struct qsdk_advance_rx rx = { .gi = { 20, 1, 4, 0, 0 } };
	struct qsdk_stats_data data = { &tx, &rx };
	struct qsdk_stats_obj object = { .level = 1, .parent_ifname = "ath1", .stats = &data };
	memcpy(object.id.mac, mac, sizeof(mac));
	memset(&result, 0, sizeof(result));
	assert(qsdk_telemetry_copy(&object, 1, "ath1", mac, &result));
	assert(result.rx.has_gi && result.tx.has_gi && !result.rx.has_mcs);
	assert(result.rx.gi[2] == 4 && result.tx.gi[4] == 1);
	assert(!qsdk_telemetry_copy(&object, 1, "ath2", mac, &result));
	assert(!qsdk_telemetry_copy(&object, 2, "ath1", mac, &result));
	mac[5]++;
	assert(!qsdk_telemetry_copy(&object, 1, "ath1", mac, &result));
	mac[5]--;
	struct qsdk_debug_tx debug_tx = { 0 };
	struct qsdk_debug_rx debug_rx = { 0 };
	debug_tx.modes[4].mcs[11] = 42;
	debug_rx.modes[5].mcs[13] = 7;
	data.tx = &debug_tx;
	data.rx = &debug_rx;
	object.level = 2;
	assert(qsdk_telemetry_copy(&object, 2, "ath1", mac, &result));
	assert(result.tx.has_mcs && result.tx.modes[2].mcs[11] == 42);
	assert(result.rx.has_mcs && result.rx.modes[3].mcs[13] == 7 && result.rx.gi[2] == 4);
	object.type = 1;
	assert(!qsdk_telemetry_copy(&object, 2, "ath1", mac, &result));
	assert(!qsdk_telemetry_read("ath1;id", "00:11:22:33:44:55", &result));
	assert(!qsdk_telemetry_read("ath1", "ff:ff:ff:ff:ff:ff", &result));
	if (sizeof(void *) != 4) assert(!qsdk_telemetry_read("ath1", "00:11:22:33:44:55", &result));
	puts("QSDK telemetry selfcheck passed: ABI, counters, identity, and unsupported provider");
	return 0;
}
