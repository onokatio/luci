/* Test-only probe; never included in an IPK. */
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
		for (i = 0; i < QSDK_MCS_COUNT; i++) {
			if (i) putchar(',');
			if (usage->modes[mode].present & (1U << i)) printf("%u", usage->modes[mode].mcs[i]);
			else printf("null");
		}
		printf("]");
	}
	printf("}}");
}

int main(int argc, char **argv)
{
	struct qsdk_telemetry result = { 0 };
	assert(qsdk_hostapd_request("", "", NULL, 1) == -1);
	if (argc == 7) {
		if (!strcmp(argv[1], "hang")) sleep(5);
		else if (!strcmp(argv[1], "large")) for (int i = 0; i < 1000; i++) puts("large output");
		else puts("test output");
		return 0;
	}
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
	const char *mac = "00:11:22:33:44:55";
	char advance[] = "Advance Data STATS For STA 00:11:22:33:44:55 (Parent ath1)\nTx Stats\n\tTx SGI = 0.8us 10, 0.4us 0, 1.6us 3, 3.2us 0\nRx Stats\n\tRx SGI = 0.8us 20, 0.4us 1, 1.6us 4, 3.2us 0\n";
	char debug[] = "Debug Data STATS For STA 00:11:22:33:44:55 (Parent ath1)\nTx Stats\n HE MCS 11 (1024-QAM 5/6) = 42\n HT MCS 0 (BPSK 1/2) = 0\nRx Stats\n EHT MCS 13 (4096-QAM 5/6) = 7\n HE MCS 1 (QPSK 1/2) = 4294967296\n HE MCS 2 (QPSK 3/4) = -1\n HE MCS 3 (16-QAM 1/2) = 8junk\n HE MCS 17 (invalid) = 8\n";
	qsdk_telemetry_parse(advance, "ath1", mac, false, &result);
	assert(result.rx.has_gi && result.tx.has_gi && !result.rx.has_mcs);
	assert(result.rx.gi[2] == 4 && result.tx.gi[0] == 10);
	qsdk_telemetry_parse(debug, "ath1", mac, true, &result);
	assert(result.tx.has_mcs && result.tx.modes[2].mcs[11] == 42);
	assert(result.tx.modes[0].present == 1 && result.tx.modes[0].mcs[0] == 0);
	assert(result.rx.has_mcs && result.rx.modes[3].mcs[13] == 7 && result.rx.gi[2] == 4);
	assert(!result.rx.modes[2].present);
	char wrong[] = "Advance Data STATS For STA 00:11:22:33:44:56 (Parent ath1)\nRx Stats\nRx SGI = 0.8us 999, 0.4us 0, 1.6us 0, 3.2us 0\n";
	qsdk_telemetry_parse(wrong, "ath1", mac, false, &result);
	assert(result.rx.gi[0] == 20);
	char wrong_vif[] = "Debug Data STATS For STA 00:11:22:33:44:55 (Parent ath2)\nTx Stats\n HE MCS 11 (1024-QAM 5/6) = 999\n";
	qsdk_telemetry_parse(wrong_vif, "ath1", mac, true, &result);
	assert(result.tx.modes[2].mcs[11] == 42);
	assert(!qsdk_telemetry_read("ath1;id", mac, &result));
	assert(!qsdk_telemetry_read("ath1", "ff:ff:ff:ff:ff:ff", &result));
	char text[128];
	const char *stderr_args[] = { "/bin/sh", "-c", "printf native-table >&2", NULL };
	assert(qsdk_exec_capture(stderr_args, text, sizeof(text), 250, true) && !strcmp(text, "native-table"));
	pid_t child;
	const char *pid_args[] = { "/bin/sh", "-c", "printf '%s' \"$$\"", NULL };
	assert(qsdk_exec_capture_pid(pid_args, text, sizeof(text), 250, false, &child));
	assert(child > 0 && strtol(text, NULL, 10) == child);
	assert(qsdk_telemetry_capture(argv[0], "ok", mac, text, sizeof(text)) && !strcmp(text, "test output\n"));
	assert(!qsdk_telemetry_capture(argv[0], "large", mac, text, sizeof(text)));
	int64_t start = qsdk_exec_millis();
	assert(!qsdk_telemetry_capture(argv[0], "hang", mac, text, sizeof(text)));
	assert(qsdk_exec_millis() - start < 2500);
	assert(!qsdk_telemetry_capture("/nonexistent/wifitelemetry", "-A", mac, text, sizeof(text)));
	puts("QSDK telemetry selfcheck passed: counters, missing values, identity, validation, truncation and deadline");
	return 0;
}
