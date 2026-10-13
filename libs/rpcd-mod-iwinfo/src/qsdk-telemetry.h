/* SPDX-License-Identifier: ISC */
#ifndef QSDK_TELEMETRY_H
#define QSDK_TELEMETRY_H
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <sys/wait.h>

#define QSDK_MCS_COUNT 17
#define QSDK_GI_COUNT 4
struct qsdk_pkt_type { uint32_t mcs[QSDK_MCS_COUNT], present; };
struct qsdk_usage {
	bool has_mcs, has_gi;
	struct qsdk_pkt_type modes[4];
	uint32_t gi[QSDK_GI_COUNT];
};
struct qsdk_telemetry { struct qsdk_usage rx, tx; };

static bool qsdk_usage_count(const char **cursor, uint32_t *value)
{
	char *end;
	unsigned long long count;
	while (isspace((unsigned char)**cursor)) (*cursor)++;
	if (!isdigit((unsigned char)**cursor)) return false;
	errno = 0;
	count = strtoull(*cursor, &end, 10);
	if (errno || count > UINT32_MAX) return false;
	*cursor = end;
	*value = count;
	return true;
}

static void qsdk_telemetry_parse(char *text, const char *vif, const char *mac, bool debug,
		struct qsdk_telemetry *result)
{
	static const char *modes[] = { "HT", "VHT", "HE", "EHT" };
	static const char *intervals[] = { "0.8us ", "0.4us ", "1.6us ", "3.2us " };
	char *line, *save, level[16], peer[18], parent[16], mode[4];
	struct qsdk_usage *usage = NULL;
	bool matched = false;
	unsigned int index, i;
	int offset;
	for (line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
		while (isspace((unsigned char)*line)) line++;
		if (strstr(line, "Data STATS For STA")) {
			offset = 0;
			matched = sscanf(line, "%15s Data STATS For STA %17s (Parent %15[^)])%n", level, peer, parent, &offset) == 3 && offset > 0 &&
				!strcmp(level, debug ? "Debug" : "Advance") && !strcasecmp(peer, mac) && !strcmp(parent, vif);
			usage = NULL;
			continue;
		}
		if (!matched) continue;
		if (!strcmp(line, "Tx Stats")) { usage = &result->tx; continue; }
		if (!strcmp(line, "Rx Stats")) { usage = &result->rx; continue; }
		if (!usage) continue;
		if (!debug && (!strncmp(line, "Tx SGI = ", 9) || !strncmp(line, "Rx SGI = ", 9))) {
			const char *cursor = line + 9;
			uint32_t counts[QSDK_GI_COUNT];
			for (i = 0; i < QSDK_GI_COUNT; i++) {
				if (strncmp(cursor, intervals[i], 6)) break;
				cursor += 6;
				if (!qsdk_usage_count(&cursor, &counts[i])) break;
				if (i + 1 < QSDK_GI_COUNT) {
					if (strncmp(cursor, ", ", 2)) break;
					cursor += 2;
				}
			}
			while (isspace((unsigned char)*cursor)) cursor++;
			if (i == QSDK_GI_COUNT && !*cursor) {
				memcpy(usage->gi, counts, sizeof(counts));
				usage->has_gi = true;
			}
		} else if (debug && sscanf(line, "%3s MCS %2u %n", mode, &index, &offset) == 2 && index < QSDK_MCS_COUNT && line[offset] == '(') {
			const char *cursor = strrchr(line + offset, '=');
			uint32_t count;
			if (!cursor) continue;
			cursor++;
			if (!qsdk_usage_count(&cursor, &count)) continue;
			while (isspace((unsigned char)*cursor)) cursor++;
			if (*cursor) continue;
			for (i = 0; i < 4; i++) if (!strcmp(mode, modes[i])) {
				usage->modes[i].mcs[index] = count;
				usage->modes[i].present |= 1U << index;
				usage->has_mcs = true;
				break;
			}
		}
	}
}

#include "../../rpcd-mod-luci/src/qsdk-exec.h"

static bool qsdk_telemetry_capture(const char *program, const char *level, const char *mac, char *text, size_t size)
{
	const char *argv[] = { program, level, "-s", "-m", mac, "-f", "TX,RX", NULL };
	return qsdk_exec_capture(argv, text, size, 1500, false);
}

static bool qsdk_telemetry_read(const char *vif, const char *mac, struct qsdk_telemetry *result)
{
	char text[32768];
	memset(result, 0, sizeof(*result));
	if (!qsdk_hostapd_ifname(vif) || !qsdk_hostapd_mac(mac)) return false;
	/* Native libnl-3 symbols conflict with RPCd's libnl-tiny; the stock executable isolates them. */
	if (qsdk_telemetry_capture("/usr/sbin/wifitelemetry", "-A", mac, text, sizeof(text)))
		qsdk_telemetry_parse(text, vif, mac, false, result);
	if (qsdk_telemetry_capture("/usr/sbin/wifitelemetry", "-D", mac, text, sizeof(text)))
		qsdk_telemetry_parse(text, vif, mac, true, result);
	return result->rx.has_mcs || result->rx.has_gi || result->tx.has_mcs || result->tx.has_gi;
}
#endif
