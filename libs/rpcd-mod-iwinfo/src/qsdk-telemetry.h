/*
 * QSDK telemetry ABI declarations adapted from stats_lib.h and wlan_stats_define.h:
 * https://github.com/niniming/openwrt-qsdk12/tree/981ff32aede2ffdc416036d001738b50a6ed7c2f/qca/src/qca-wifi
 * Copyright (c) 2021 The Linux Foundation. All rights reserved.
 * Copyright (c) 2021-2023 Qualcomm Innovation Center, Inc. All rights reserved.
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
#ifndef QSDK_TELEMETRY_H
#define QSDK_TELEMETRY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <dlfcn.h>

#define QSDK_MCS_COUNT 17
#define QSDK_GI_COUNT 5

struct qsdk_stats_obj {
	int level, object, type;
	char parent_ifname[16];
	uint8_t serviceid;
	union { uint8_t mac[6]; char ifname[16]; } id;
	void *stats;
	struct qsdk_stats_obj *next, *parent;
};
struct qsdk_stats_reply { struct qsdk_stats_obj *head, *last; };
struct qsdk_stats_command {
	int level, object, type;
	bool recursive, mld_link;
	uint8_t serviceid;
	char ifname[16];
	uint64_t features;
	uint8_t mac[6];
	struct qsdk_stats_reply *reply;
	int peer_type;
	void (*async_callback)(struct qsdk_stats_command *, char *);
};
struct qsdk_pkt_info { uint64_t packets, bytes; };
struct qsdk_pkt_type { uint32_t mcs[QSDK_MCS_COUNT]; };

/* Only the prefixes consumed here are declared; the native library owns the buffers. */
struct qsdk_advance_tx {
	uint64_t basic[6];
	struct qsdk_pkt_info unicast, multicast, broadcast;
	struct qsdk_pkt_type su_eht, mu_eht[2];
	uint32_t nss[8], gi[QSDK_GI_COUNT];
};
struct qsdk_advance_rx {
	uint64_t basic[5];
	struct qsdk_pkt_info unicast, multicast, broadcast;
	struct qsdk_pkt_type su_eht, mu_eht[2];
	uint32_t su_he[QSDK_MCS_COUNT], rx_mpdu[QSDK_MCS_COUNT], wme[4], gi[QSDK_GI_COUNT];
};
struct qsdk_debug_tx {
	uint64_t basic[6];
	uint32_t inactive, ofdma, stbc, ldpc, preamble_puncture, ppdu_cookie, fw_rem_notx, fw_rem_tx;
	uint32_t age_out, fw_reason[3], ru_start, ru_tones, wme[4], excess_retries[4];
	uint32_t mu_group[64], no_ack[60];
	struct qsdk_pkt_info fw_rem;
	struct qsdk_pkt_type modes[6];
};
struct qsdk_debug_rx {
	uint64_t basic[5];
	uint32_t discard, mic_error, decrypt_error, fcs_error, pn_error, out_of_order;
	uint32_t ppdu[4], reception[4];
	struct qsdk_pkt_info mec_drop;
	struct qsdk_pkt_type modes[6];
};
struct qsdk_stats_data { void *tx, *rx; };
struct qsdk_usage {
	bool has_mcs, has_gi;
	struct qsdk_pkt_type modes[4];
	uint32_t gi[QSDK_GI_COUNT];
};
struct qsdk_telemetry { struct qsdk_usage rx, tx; };

_Static_assert(offsetof(struct qsdk_advance_tx, gi) == 0x14c, "QSDK TX GI ABI");
_Static_assert(offsetof(struct qsdk_advance_rx, gi) == 0x1bc, "QSDK RX GI ABI");
_Static_assert(offsetof(struct qsdk_debug_tx, modes) == 0x288, "QSDK TX MCS ABI");
_Static_assert(offsetof(struct qsdk_debug_rx, modes) == 0x70, "QSDK RX MCS ABI");
#if UINTPTR_MAX == UINT32_MAX
_Static_assert(offsetof(struct qsdk_stats_command, ifname) == 15, "QSDK command interface ABI");
_Static_assert(offsetof(struct qsdk_stats_command, features) == 32, "QSDK command features ABI");
_Static_assert(offsetof(struct qsdk_stats_command, mac) == 40, "QSDK command MAC ABI");
_Static_assert(offsetof(struct qsdk_stats_command, reply) == 48, "QSDK command reply ABI");
_Static_assert(offsetof(struct qsdk_stats_command, peer_type) == 52, "QSDK peer type ABI");
_Static_assert(sizeof(struct qsdk_stats_command) == 64, "QSDK command size ABI");
_Static_assert(offsetof(struct qsdk_stats_obj, stats) == 48, "QSDK response ABI");
#endif

static bool qsdk_telemetry_library_matches(void)
{
	FILE *file;
	unsigned char bytes[4096];
	size_t length, i;
	uint64_t fingerprint = UINT64_C(14695981039346656037);
	if (sizeof(void *) != 4) return false;
	file = fopen("/usr/lib/libstats_lib.so", "rb");
	if (!file) return false;
	while ((length = fread(bytes, 1, sizeof(bytes), file)) != 0)
		for (i = 0; i < length; i++) fingerprint = (fingerprint ^ bytes[i]) * UINT64_C(1099511628211);
	bool valid = !ferror(file) && fingerprint == UINT64_C(0x8ca5a81b0ecf45ce);
	fclose(file);
	/* shortcut: only the stock v2.5.1 ABI; verify the layout before adding another firmware. */
	return valid;
}

static bool qsdk_telemetry_copy(struct qsdk_stats_obj *object, int level,
		const char *vif, const uint8_t mac[6], struct qsdk_telemetry *result)
{
	struct qsdk_stats_data *data;
	if (!object || object->level != level || object->object != 0 || object->type != 0 ||
		memcmp(object->id.mac, mac, 6) || strnlen(object->parent_ifname, 16) == 16 ||
		strcmp(object->parent_ifname, vif) || !object->stats) return false;
	data = object->stats;
	if (level == 1) {
		if (data->tx) {
			memcpy(result->tx.gi, ((struct qsdk_advance_tx *)data->tx)->gi, sizeof(result->tx.gi));
			result->tx.has_gi = true;
		}
		if (data->rx) {
			memcpy(result->rx.gi, ((struct qsdk_advance_rx *)data->rx)->gi, sizeof(result->rx.gi));
			result->rx.has_gi = true;
		}
	} else if (level == 2) {
		if (data->tx) {
			memcpy(result->tx.modes, ((struct qsdk_debug_tx *)data->tx)->modes + 2, sizeof(result->tx.modes));
			result->tx.has_mcs = true;
		}
		if (data->rx) {
			memcpy(result->rx.modes, ((struct qsdk_debug_rx *)data->rx)->modes + 2, sizeof(result->rx.modes));
			result->rx.has_mcs = true;
		}
	}
	return true;
}

static bool qsdk_telemetry_read(const char *vif, const char *mac, struct qsdk_telemetry *result)
{
	static void *library;
	static bool attempted;
	static int32_t (*request)(struct qsdk_stats_command *);
	static void (*release)(struct qsdk_stats_command *);
	static uint64_t (*features)(char *);
	struct qsdk_stats_reply reply;
	struct qsdk_stats_command command;
	struct qsdk_stats_obj *object;
	int level, count;
	memset(result, 0, sizeof(*result));
	if (!qsdk_hostapd_ifname(vif) || !qsdk_hostapd_mac(mac)) return false;
	if (!attempted) {
		attempted = true;
		if (qsdk_telemetry_library_matches()) {
			/* Native libraries leave these symbols to their executable instead of declaring dependencies. */
			const char *dependencies[] = { "libnl-3.so.200", "libnl-genl-3.so.200", "libqca_tools.so", "/usr/local/lib/libqca_nl80211_wrapper.so" };
			unsigned int i;
			for (i = 0; i < sizeof(dependencies) / sizeof(dependencies[0]); i++)
				if (!dlopen(dependencies[i], RTLD_NOW | RTLD_GLOBAL)) return false;
			library = dlopen("/usr/lib/libstats_lib.so", RTLD_NOW | RTLD_LOCAL);
		}
		if (library) {
			request = dlsym(library, "libstats_request_handle");
			release = dlsym(library, "libstats_free_reply_buffer");
			features = dlsym(library, "libstats_get_feature_flag");
		}
	}
	if (!request || !release || !features) return false;
	for (level = 1; level <= 2; level++) {
		char feature_names[] = "TX,RX";
		memset(&command, 0, sizeof(command));
		memset(&reply, 0, sizeof(reply));
		command.level = level;
		command.peer_type = 3;
		command.features = features(feature_names);
		command.reply = &reply;
		memcpy(command.ifname, vif, strlen(vif) + 1);
		sscanf(mac, "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx", &command.mac[0], &command.mac[1],
			&command.mac[2], &command.mac[3], &command.mac[4], &command.mac[5]);
		if (!request(&command))
			for (object = reply.head, count = 0; object && count < 32; object = object->next, count++)
				if (qsdk_telemetry_copy(object, level, vif, command.mac, result)) break;
		release(&command);
	}
	return result->rx.has_mcs || result->rx.has_gi || result->tx.has_mcs || result->tx.has_gi;
}
#endif
