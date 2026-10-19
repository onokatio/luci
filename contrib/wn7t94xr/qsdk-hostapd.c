/* SPDX-License-Identifier: ISC */
#include <dirent.h>
#include <libubus.h>
#include <libubox/uloop.h>
#include <rpcd/plugin.h>
#include "qsdk-hostapd.h"

static int qsdk_hostapd_api_init(const struct rpc_daemon_ops *ops, struct ubus_context *ctx)
{
	qsdk_hostapd_init(ctx);
	return 0;
}

struct rpc_plugin rpc_plugin = { .init = qsdk_hostapd_api_init };
