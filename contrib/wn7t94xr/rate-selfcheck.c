#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <libubus.h>
#include <rpcd/plugin.h>
#include <iwinfo.h>

static struct ubus_object *registered;
static struct iwinfo_assoclist_entry station;
static int replies;

static int assoclist(const char *device, char *entries, int *length)
{
	assert(!strcmp(device, "ath-test"));
	memcpy(entries, &station, sizeof(station));
	*length = sizeof(station);
	return 0;
}

const struct iwinfo_ops *iwinfo_backend(const char *device)
{
	static const struct iwinfo_ops backend = { .name = "qcawificfg80211", .assoclist = assoclist };
	assert(!strcmp(device, "ath-test"));
	return &backend;
}

int ubus_add_object(struct ubus_context *ctx, struct ubus_object *object)
{
	assert(!registered && !strcmp(object->name, "iwinfo"));
	registered = object;
	return 0;
}

int ubus_send_reply(struct ubus_context *ctx, struct ubus_request_data *request, struct blob_attr *reply)
{
	const struct blobmsg_policy result = { .name = "results", .type = BLOBMSG_TYPE_ARRAY };
	const struct blobmsg_policy rates[] = { { .name = "rx", .type = BLOBMSG_TYPE_TABLE }, { .name = "tx", .type = BLOBMSG_TYPE_TABLE } };
	const struct blobmsg_policy fields[] = {
		{ .name = "mhz", .type = BLOBMSG_TYPE_INT32 }, { .name = "eht", .type = BLOBMSG_TYPE_BOOL },
		{ .name = "mcs", .type = BLOBMSG_TYPE_INT32 }, { .name = "nss", .type = BLOBMSG_TYPE_INT32 },
		{ .name = "eht_gi", .type = BLOBMSG_TYPE_INT32 }
	};
	struct blob_attr *array, *entry, *rx_tx[2], *tb[5];
	int i;
	blobmsg_parse(&result, 1, &array, blob_data(reply), blob_len(reply));
	assert(array && blobmsg_data_len(array));
	entry = blobmsg_data(array);
	blobmsg_parse(rates, 2, rx_tx, blobmsg_data(entry), blobmsg_data_len(entry));
	for (i = 0; i < 2; i++) {
		assert(rx_tx[i]);
		blobmsg_parse(fields, 5, tb, blobmsg_data(rx_tx[i]), blobmsg_data_len(rx_tx[i]));
		assert(tb[0] && blobmsg_get_u32(tb[0]) == 320);
		assert(tb[1] && blobmsg_get_bool(tb[1]));
		assert(!tb[2] && tb[3] && blobmsg_get_u32(tb[3]) == 2);
		assert(!tb[4]);
	}
	replies++;
	return 0;
}

int main(int argc, char **argv)
{
	struct blob_buf request = {0};
	struct rpc_plugin *plugin;
	void *library;
	int i;
	assert(argc == 2);
	library = dlopen(argv[1], RTLD_NOW);
	if (!library) fprintf(stderr, "%s\n", dlerror());
	assert(library);
	plugin = dlsym(library, "rpc_plugin");
	assert(plugin && !plugin->init(NULL, NULL));
	assert(registered);
	station.rx_rate = (struct iwinfo_rate_entry) { .rate = 5764800, .mcs = -1, .is_eht = 1, .mhz_hi = 1, .mhz = 64, .eht_gi = UINT8_MAX, .nss = 2 };
	station.tx_rate = station.rx_rate;
	blob_buf_init(&request, 0);
	blobmsg_add_string(&request, "device", "ath-test");
	for (i = 0; i < registered->n_methods; i++)
		if (!strcmp(registered->methods[i].name, "assoclist")) {
			assert(!registered->methods[i].handler(NULL, registered, NULL, "assoclist", request.head));
			break;
		}
	assert(replies == 1);
	blob_buf_free(&request);
	dlclose(library);
	puts("PASS: unmodified compiled RPC plugin via rpc_plugin ABI and registered assoclist method; rx/tx 320 MHz, EHT, NSS, omitted unknown MCS/GI");
	return 0;
}
