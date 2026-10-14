/* SPDX-License-Identifier: ISC */
#include "qsdk-hostapd-control.h"

static int qsdk_hostapd_ok(const char *path, const char *command)
{
	char reply[64];
	return qsdk_hostapd_request(path, command, reply, sizeof(reply)) >= 0 && !strcmp(reply, "OK\n");
}

struct qsdk_hostapd_ban {
	struct list_head list;
	struct uloop_timeout timer;
	char path[108], mac[18], journal[128];
};

struct qsdk_hostapd_vif {
	struct list_head list;
	struct ubus_object object;
	char name[IFNAMSIZ + 8], path[108];
	int seen;
};

static LIST_HEAD(qsdk_hostapd_vifs);
static LIST_HEAD(qsdk_hostapd_bans);
static struct ubus_context *qsdk_hostapd_context;

static void qsdk_hostapd_unban(struct uloop_timeout *timer)
{
	struct qsdk_hostapd_ban *ban = container_of(timer, struct qsdk_hostapd_ban, timer);
	char command[64];
	snprintf(command, sizeof(command), "DENY_ACL DEL_MAC %s", ban->mac);
	if (!qsdk_hostapd_ok(ban->path, command) && !access(ban->path, F_OK)) {
		uloop_timeout_set(timer, 2000);
		return;
	}
	unlink(ban->journal);
	list_del(&ban->list);
	free(ban);
}

static void qsdk_hostapd_recover_bans(void)
{
	DIR *dir = opendir("/var/run");
	struct dirent *entry;
	struct qsdk_hostapd_ban *ban;
	char journal[128], path[108], mac[18], expected[108], command[64], *ifname;
	FILE *file;
	int radio, valid, owned;
	if (!dir) return;
	while ((entry = readdir(dir))) {
		if (strncmp(entry->d_name, "qsdk-ban-", 9)) continue;
		snprintf(journal, sizeof(journal), "/var/run/%.100s", entry->d_name);
		owned = 0;
		list_for_each_entry(ban, &qsdk_hostapd_bans, list)
			if (!strcmp(ban->journal, journal)) owned = 1;
		if (owned || !(file = fopen(journal, "r"))) continue;
		valid = fscanf(file, "%107s %17s", path, mac) == 2;
		fclose(file);
		if (!valid || !qsdk_hostapd_mac(mac) || !(ifname = strrchr(path, '/')) || !qsdk_hostapd_ifname(++ifname)) continue;
		valid = 0;
		for (radio = 0; radio < 3; radio++) {
			snprintf(expected, sizeof(expected), "/var/run/hostapd-wifi%d/%s", radio, ifname);
			if (!strcmp(path, expected)) valid = 1;
		}
		if (!valid) continue;
		snprintf(command, sizeof(command), "DENY_ACL DEL_MAC %s", mac);
		/* A rpcd restart must not leave its temporary deny entries in native hostapd. */
		if (access(path, F_OK) || qsdk_hostapd_ok(path, command)) unlink(journal);
	}
	closedir(dir);
}

enum { QH_ADDR, QH_DEAUTH, QH_REASON, QH_BAN, QH_COUNT };
static const struct blobmsg_policy qsdk_hostapd_policy[QH_COUNT] = {
	[QH_ADDR] = { .name = "addr", .type = BLOBMSG_TYPE_STRING },
	[QH_DEAUTH] = { .name = "deauth", .type = BLOBMSG_TYPE_BOOL },
	[QH_REASON] = { .name = "reason", .type = BLOBMSG_TYPE_INT32 },
	[QH_BAN] = { .name = "ban_time", .type = BLOBMSG_TYPE_INT32 },
};

static int qsdk_hostapd_del_client(struct ubus_context *ctx, struct ubus_object *object,
	struct ubus_request_data *req, const char *method, struct blob_attr *message)
{
	struct qsdk_hostapd_vif *vif = container_of(object, struct qsdk_hostapd_vif, object);
	struct qsdk_hostapd_ban *ban, *pending = NULL;
	struct blob_attr *tb[QH_COUNT];
	const char *mac;
	char command[80], reply[8192], *line, *save;
	unsigned int reason = 1, duration = 0, count = 0;
	int present = 0, added = 0, fd;
	if (!message) return UBUS_STATUS_INVALID_ARGUMENT;
	blobmsg_parse(qsdk_hostapd_policy, QH_COUNT, tb, blob_data(message), blob_len(message));
	if (!tb[QH_ADDR] || !qsdk_hostapd_mac(mac = blobmsg_get_string(tb[QH_ADDR]))) return UBUS_STATUS_INVALID_ARGUMENT;
	if (tb[QH_REASON]) reason = blobmsg_get_u32(tb[QH_REASON]);
	if (tb[QH_BAN]) duration = blobmsg_get_u32(tb[QH_BAN]);
	if (!reason || reason > 65535 || duration > 3600000) return UBUS_STATUS_INVALID_ARGUMENT;
	if (duration) {
		list_for_each_entry(ban, &qsdk_hostapd_bans, list) {
			count++;
			if (!strcmp(ban->path, vif->path) && !strcasecmp(ban->mac, mac)) pending = ban;
		}
		if (!pending) {
			if (qsdk_hostapd_request(vif->path, "DENY_ACL SHOW", reply, sizeof(reply)) < 0 || !strncmp(reply, "FAIL", 4)) return UBUS_STATUS_UNKNOWN_ERROR;
			for (line = strtok_r(reply, "\n", &save); line; line = strtok_r(NULL, "\n", &save))
				if (!strncasecmp(line, mac, 17) && (!line[17] || isspace((unsigned char)line[17]))) present = 1;
			if (!present) {
				if (count >= 512 || !(pending = calloc(1, sizeof(*pending)))) return UBUS_STATUS_UNKNOWN_ERROR;
				strcpy(pending->path, vif->path);
				strcpy(pending->mac, mac);
				pending->timer.cb = qsdk_hostapd_unban;
				snprintf(pending->journal, sizeof(pending->journal), "/var/run/qsdk-ban-%s-%s", vif->name + 8, mac);
				fd = open(pending->journal, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
				if (fd < 0) { free(pending); return UBUS_STATUS_UNKNOWN_ERROR; }
				if (dprintf(fd, "%s %s\n", vif->path, mac) < 0) {
					close(fd); unlink(pending->journal); free(pending); return UBUS_STATUS_UNKNOWN_ERROR;
				}
				close(fd);
				snprintf(command, sizeof(command), "DENY_ACL ADD_MAC %s", mac);
				if (!qsdk_hostapd_ok(vif->path, command)) { unlink(pending->journal); free(pending); return UBUS_STATUS_UNKNOWN_ERROR; }
				list_add(&pending->list, &qsdk_hostapd_bans);
				added = 1;
			}
		}
	}
	snprintf(command, sizeof(command), "%s %s reason=%u",
		tb[QH_DEAUTH] && blobmsg_get_bool(tb[QH_DEAUTH]) ? "DEAUTHENTICATE" : "DISASSOCIATE", mac, reason);
	if (!qsdk_hostapd_ok(vif->path, command)) {
		if (added) qsdk_hostapd_unban(&pending->timer);
		return UBUS_STATUS_UNKNOWN_ERROR;
	}
	if (pending) uloop_timeout_set(&pending->timer, duration);
	return UBUS_STATUS_OK;
}

#include "qsdk-hostapd-management.h"
#include "qsdk-hostapd-info.h"

static const struct ubus_method qsdk_hostapd_methods[] = {
	UBUS_METHOD_NOARG("get_clients", qsdk_hostapd_info),
	UBUS_METHOD_NOARG("get_status", qsdk_hostapd_info),
	UBUS_METHOD_NOARG("get_features", qsdk_hostapd_info),
	UBUS_METHOD("del_client", qsdk_hostapd_del_client, qsdk_hostapd_policy),
	UBUS_METHOD_NOARG("wps_start", qsdk_hostapd_wps),
	UBUS_METHOD_NOARG("wps_cancel", qsdk_hostapd_wps),
	UBUS_METHOD_NOARG("wps_status", qsdk_hostapd_wps),
	UBUS_METHOD("bss_transition_request", qsdk_hostapd_transition, qsdk_management_policy),
	UBUS_METHOD("rrm_beacon_req", qsdk_hostapd_transition, qsdk_management_policy),
	UBUS_METHOD_NOARG("rrm_nr_list", qsdk_hostapd_neighbor),
	UBUS_METHOD("qsdk_rrm_nr_add", qsdk_hostapd_neighbor, qsdk_neighbor_policy),
	UBUS_METHOD("qsdk_rrm_nr_remove", qsdk_hostapd_neighbor, qsdk_neighbor_policy),
};
static struct ubus_object_type qsdk_hostapd_type = UBUS_OBJECT_TYPE("qsdk-hostapd", qsdk_hostapd_methods);

static void qsdk_hostapd_sync(struct uloop_timeout *timer)
{
	struct qsdk_hostapd_vif *vif, *next;
	struct stat st;
	struct dirent *entry;
	char directory[64], path[108], name[IFNAMSIZ + 8], parent[128];
	uint32_t id;
	DIR *dir;
	int radio;
	qsdk_hostapd_recover_bans();
	list_for_each_entry(vif, &qsdk_hostapd_vifs, list) vif->seen = 0;
	for (radio = 0; radio < 3; radio++) {
		snprintf(directory, sizeof(directory), "/var/run/hostapd-wifi%d", radio);
		dir = opendir(directory);
		if (!dir) continue;
		while ((entry = readdir(dir))) {
			if (!qsdk_hostapd_ifname(entry->d_name)) continue;
			snprintf(parent, sizeof(parent), "/sys/class/net/wifi%d/hwmodes", radio);
			if (access(parent, R_OK)) continue;
			snprintf(path, sizeof(path), "%s/%.15s", directory, entry->d_name);
			if (stat(path, &st) || !S_ISSOCK(st.st_mode)) continue;
			snprintf(name, sizeof(name), "hostapd.%.15s", entry->d_name);
			vif = NULL;
			list_for_each_entry(next, &qsdk_hostapd_vifs, list)
				if (!strcmp(next->name, name)) { vif = next; break; }
		if (vif) { vif->seen = 1; strcpy(vif->path, path); continue; }
			/* Leave a genuine hostapd ubus implementation in control when present. */
			if (!ubus_lookup_id(qsdk_hostapd_context, name, &id)) continue;
			vif = calloc(1, sizeof(*vif));
			if (!vif) continue;
			strcpy(vif->name, name);
			strcpy(vif->path, path);
			vif->object.name = vif->name;
			vif->object.type = &qsdk_hostapd_type;
			vif->object.methods = qsdk_hostapd_methods;
			vif->object.n_methods = ARRAY_SIZE(qsdk_hostapd_methods);
			if (ubus_add_object(qsdk_hostapd_context, &vif->object)) { free(vif); continue; }
			vif->seen = 1;
			list_add(&vif->list, &qsdk_hostapd_vifs);
		}
		closedir(dir);
	}
	list_for_each_entry_safe(vif, next, &qsdk_hostapd_vifs, list) {
		if (vif->seen) continue;
		ubus_remove_object(qsdk_hostapd_context, &vif->object);
		list_del(&vif->list);
		free(vif);
	}
	uloop_timeout_set(timer, 2000);
}

static void qsdk_hostapd_init(struct ubus_context *ctx)
{
	static struct uloop_timeout timer = { .cb = qsdk_hostapd_sync };
	qsdk_hostapd_context = ctx;
	qsdk_hostapd_sync(&timer);
}
