#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <libubox/blobmsg_json.h>
#include <string.h>
#include <libubus.h>
#include <rpcd/plugin.h>
#include <iwinfo.h>

static struct ubus_object *registered;
static struct iwinfo_assoclist_entry station;
static int replies;
static enum { UNKNOWN, KNOWN, FREQUENCIES } testcase;

static struct blob_attr *field(struct blob_attr *table, const char *name)
{
	struct blob_attr *value;
	int rem;
	blobmsg_for_each_attr(value, table, rem)
		if (!strcmp(blobmsg_name(value), name)) return value;
	return NULL;
}

static int assoclist(const char *device, char *entries, int *length)
{
	assert(!strcmp(device, "ath-test"));
	memcpy(entries, &station, sizeof(station));
	*length = sizeof(station);
	return 0;
}

static int freqlist(const char *device, char *entries, int *length)
{
	const struct iwinfo_freqlist_entry frequencies[] = {
		{ .band = IWINFO_BAND_24, .channel = 1, .mhz = 2412 },
		{ .band = IWINFO_BAND_5, .channel = 36, .mhz = 5180 },
		{ .band = IWINFO_BAND_6, .channel = 1, .mhz = 5955, .restricted = 1, .flags = IWINFO_FREQ_NO_IR },
		{ .band = IWINFO_BAND_60, .channel = 1, .mhz = 58320 }
	};
	assert(!strcmp(device, "ath-test"));
	memcpy(entries, frequencies, sizeof(frequencies));
	*length = sizeof(frequencies);
	return 0;
}

static int channel(const char *device, int *value) { *value = 1; return 0; }

const struct iwinfo_ops *iwinfo_backend(const char *device)
{
	/* Exercise the compiled official plugin through its registered ubus methods. */
	static const struct iwinfo_ops backend = { .name = "metadata-test", .assoclist = assoclist, .freqlist = freqlist, .channel = channel };
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
	struct blob_attr *array, *entry, *value, *rate;
	int i, rem, count = 0;
	blobmsg_parse(&result, 1, &array, blob_data(reply), blob_len(reply));
	assert(array && blobmsg_data_len(array));
	if (testcase == FREQUENCIES) {
		const int bands[] = { 2, 5, 6, 60 };
		blobmsg_for_each_attr(entry, array, rem) {
			int band_keys = 0, rem2;
			assert(count < 4);
			assert(blobmsg_get_u32(field(entry, "band")) == bands[count]);
			assert(!field(entry, "no_ir"));
			assert(field(entry, "flags"));
			assert(blobmsg_get_bool(field(entry, "restricted")) == (count == 2));
			blobmsg_for_each_attr(value, entry, rem2)
				if (!strcmp(blobmsg_name(value), "band")) band_keys++;
			assert(band_keys == 1);
			count++;
		}
		assert(count == 4);
	}
	else {
		entry = blobmsg_data(array);
		assert(field(entry, "signal_avg") && !blobmsg_get_u32(field(entry, "signal_avg")));
		assert(field(entry, "authorized") && !blobmsg_get_bool(field(entry, "authorized")));
		for (i = 0; i < 2; i++) {
			rate = field(entry, i ? "tx" : "rx");
			assert(rate && blobmsg_get_u32(field(rate, "mhz")) == 320);
			assert(blobmsg_get_bool(field(rate, "eht")));
			assert(blobmsg_get_u32(field(rate, "nss")) == 2);
			assert(blobmsg_get_u32(field(rate, "mcs")) == (testcase == UNKNOWN ? UINT32_MAX : 0));
			assert(blobmsg_get_u32(field(rate, "eht_gi")) == (testcase == UNKNOWN ? UINT8_MAX : 0));
		}
	}
	char *json = blobmsg_format_json(reply, true);
	assert(json);
	puts(json);
	free(json);
	replies++;
	return 0;
}

static void call(const char *method)
{
	struct blob_buf request = {0};
	int i, before = replies;
	blob_buf_init(&request, 0);
	blobmsg_add_string(&request, "device", "ath-test");
	for (i = 0; i < registered->n_methods; i++)
		if (!strcmp(registered->methods[i].name, method)) {
			assert(!registered->methods[i].handler(NULL, registered, NULL, method, request.head));
			break;
		}
	assert(replies == before + 1);
	blob_buf_free(&request);
}

int main(int argc, char **argv)
{
	struct rpc_plugin *plugin;
	void *library;
	assert(argc == 2);
	library = dlopen(argv[1], RTLD_NOW);
	if (!library) fprintf(stderr, "%s\n", dlerror());
	assert(library);
	plugin = dlsym(library, "rpc_plugin");
	assert(plugin && !plugin->init(NULL, NULL));
	assert(registered);
	station.rx_rate = (struct iwinfo_rate_entry) { .rate = 5764800, .mcs = -1, .is_eht = 1, .mhz_hi = 1, .mhz = 64, .eht_gi = UINT8_MAX, .nss = 2 };
	station.tx_rate = station.rx_rate;
	call("assoclist");
	testcase = KNOWN;
	station.rx_rate.mcs = station.tx_rate.mcs = 0;
	station.rx_rate.eht_gi = station.tx_rate.eht_gi = 0;
	call("assoclist");
	testcase = FREQUENCIES;
	call("freqlist");
	dlclose(library);
	fprintf(stderr, "PASS: compiled official RPC via public ABI; zero values, 320 MHz, unknown MCS/GI sentinels and frequency flags\n");
	return 0;
}
