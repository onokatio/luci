#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <libubox/blobmsg_json.h>
#include <libubox/list.h>
#include "qsdk-hostapd-control.h"
struct ubus_context; struct ubus_request_data;
struct ubus_object { int unused; };
struct qsdk_hostapd_vif { struct ubus_object object; char path[108]; };
#define UBUS_STATUS_OK 0
#define UBUS_STATUS_INVALID_ARGUMENT 2
#define UBUS_STATUS_NOT_SUPPORTED 8
#define UBUS_STATUS_UNKNOWN_ERROR 9
static char captured[4096], response[8192] = "OK\n", *sent;
static int ubus_send_reply(struct ubus_context *ctx, struct ubus_request_data *req, struct blob_attr *head)
{ free(sent); sent = blobmsg_format_json(head, true); return 0; }
static int capture(const char *path, const char *command, char *reply, size_t size)
{ snprintf(captured, sizeof(captured), "%s", command); snprintf(reply, size, "%s", response); return strlen(reply); }
#define qsdk_hostapd_request capture
static int qsdk_hostapd_ok(const char *path, const char *command)
{ char reply[64]; return capture(path, command, reply, sizeof(reply)) >= 0 && !strcmp(reply, "OK\n"); }
#include "qsdk-hostapd-management.h"
int main(void)
{
 struct blob_buf args = {}; struct qsdk_hostapd_vif vif = {};
 blob_buf_init(&args, 0);
 assert(blobmsg_add_json_from_string(&args, "{\"addr\":\"02:00:00:00:00:01\",\"op_class\":115,\"channel\":36,\"duration\":50,\"mode\":0,\"ssid\":\"test\"}"));
 assert(!qsdk_hostapd_transition(NULL,&vif.object,NULL,"rrm_beacon_req",args.head));
 assert(!strcmp(captured, "REQ_BEACON 02:00:00:00:00:01 73240000320000ffffffffffff000474657374"));
 blob_buf_free(&args); blob_buf_init(&args, 0);
 assert(blobmsg_add_json_from_string(&args,"{\"addr\":\"02:00:00:00:00:01\",\"op_class\":115,\"channel\":36,\"duration\":65536,\"mode\":0}"));
 assert(qsdk_hostapd_transition(NULL,&vif.object,NULL,"rrm_beacon_req",args.head)==UBUS_STATUS_INVALID_ARGUMENT);
 strcpy(response, "PBC Status: Active\nLast WPS result: None\n");
 assert(!qsdk_hostapd_wps(NULL,&vif.object,NULL,"wps_status",NULL));
 assert(strstr(sent,"\"last_wps_result\":\"None\""));
 strcpy(response,"02:11:22:33:44:66 ssid=74657374 nr=02112233446600000000732409\n");
 assert(!qsdk_hostapd_neighbor(NULL,&vif.object,NULL,"rrm_nr_list",NULL));
 assert(strstr(sent,"test") && strstr(sent,"02112233446600000000732409"));
 assert(qsdk_hostapd_report("02112233446600000000732409"));
 assert(!qsdk_hostapd_report("02112233446600000000732409030201"));
 free(sent); blob_buf_free(&args);
 puts("QSDK wireless management selfcheck passed: standard beacon encoding, bounds, WPS and neighbor reports");
 return 0;
}
