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
static enum { UNKNOWN, KNOWN, LEGACY, FREQUENCIES } testcase;

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
	/* Optional metadata must work independently of the backend name. */
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
			assert(blobmsg_get_bool(field(entry, "no_ir")) == (count == 2));
			assert(blobmsg_get_bool(field(entry, "restricted")) == (count == 2));
			blobmsg_for_each_attr(value, entry, rem2)
				if (!strcmp(blobmsg_name(value), "band")) band_keys++;
			assert(band_keys == 1);
			count++;
		}
		assert(count == 4);
	}
	else {
		const char *unknown[] = { "inactive", "thr", "authenticated", "preamble", "wme", "mfp", "tdls" };
		entry = blobmsg_data(array);
		for (i = 0; i < sizeof(unknown) / sizeof(unknown[0]); i++)
			assert(!!field(entry, unknown[i]) == (testcase == LEGACY));
		assert(!!field(entry, "signal_avg") == (testcase != UNKNOWN));
		assert(!!field(entry, "connected_time") == (testcase != UNKNOWN));
		assert(!!field(entry, "authorized") == (testcase != UNKNOWN));
		if (testcase != UNKNOWN) {
			assert(!blobmsg_get_u32(field(entry, "signal_avg")));
			assert(!blobmsg_get_u32(field(entry, "connected_time")));
			assert(!blobmsg_get_bool(field(entry, "authorized")));
		}
		for (i = 0; i < 2; i++) {
			rate = field(entry, i ? "tx" : "rx");
			assert(rate && blobmsg_get_u32(field(rate, "mhz")) == 320);
			assert(blobmsg_get_bool(field(rate, "eht")));
			assert(blobmsg_get_u32(field(rate, "nss")) == 2);
			assert(!!field(rate, "mcs") == (testcase != UNKNOWN));
			assert(!!field(rate, "eht_gi") == (testcase != UNKNOWN));
			if (testcase != UNKNOWN) {
				assert(!blobmsg_get_u32(field(rate, "mcs")));
				assert(!blobmsg_get_u32(field(rate, "eht_gi")));
			}
			assert(!!field(rate, i ? "packets" : "bytes") == (testcase != UNKNOWN));
			assert(!!field(rate, i ? "bytes" : "packets") == (testcase == LEGACY));
		}
	}
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
	station.stats_mask = IWINFO_ASSOC_S_VALID;
	station.rx_rate = (struct iwinfo_rate_entry) { .rate = 5764800, .mcs = -1, .is_eht = 1, .mhz_hi = 1, .mhz = 64, .eht_gi = UINT8_MAX, .nss = 2 };
	station.tx_rate = station.rx_rate;
	call("assoclist");
	testcase = KNOWN;
	station.stats_mask |= IWINFO_ASSOC_S_SIGNAL_AVG | IWINFO_ASSOC_S_CONNECTED_TIME | IWINFO_ASSOC_S_RX_BYTES | IWINFO_ASSOC_S_TX_PACKETS;
	station.flags_mask = IWINFO_ASSOC_F_AUTHORIZED;
	station.rx_rate.mcs = station.tx_rate.mcs = 0;
	station.rx_rate.eht_gi = station.tx_rate.eht_gi = 0;
	call("assoclist");
	testcase = LEGACY;
	station.stats_mask = station.flags_mask = 0;
	call("assoclist");
	testcase = FREQUENCIES;
	call("freqlist");
	dlclose(library);
	puts("PASS: compiled RPC via public ABI; generic optional metadata, known zero values, legacy fields, 320 MHz, unknown MCS/GI, normalized bands and no-IR");
	return 0;
}
