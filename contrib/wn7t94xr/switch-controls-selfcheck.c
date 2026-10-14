#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include "qsdk-switch-controls.inc"
int main(void)
{
	unsigned int value;
	assert(qsdk_ssdk_field("rate portshaper get 1\n[Status]:ENABLE\n[cir]:0x186a0\noperation done.\n\n", "rate portshaper get 1", "cir", &value) && value==100000);
	assert(!qsdk_ssdk_field("rate portshaper get 1\nnot supported\n\nrate portshaper get 2\n[cir]:0x123\noperation done.\n\n", "rate portshaper get 1", "cir", &value));
	assert(!qsdk_ssdk_field("rate portshaper get 1\n[cir]:-1\noperation done.\n\n", "rate portshaper get 1", "cir", &value));
	struct qsdk_switch_config wanted={.monitor=15},actual;
	assert(qsdk_switch_valid(&wanted));
	wanted.port[0].storm=1000;wanted.port[0].storm_mask=8;assert(qsdk_switch_valid(&wanted));
	assert(qsdk_switch_rate(313,true)==314);
	assert(qsdk_switch_rate(469,true)==471);
	assert(qsdk_switch_rate(100099,false)==100080);
	actual=wanted;actual.port[0].storm=939;assert(qsdk_switch_matches(&actual,&wanted));
	actual.port[0].storm=0;assert(!qsdk_switch_matches(&actual,&wanted));
	wanted.port[0].ingress=1000;assert(!qsdk_switch_valid(&wanted));wanted.port[0].ingress=0;
	wanted.port[0].mirror_rx=1;assert(!qsdk_switch_valid(&wanted));wanted.monitor=2;assert(qsdk_switch_valid(&wanted));
	wanted.monitor=1;assert(!qsdk_switch_valid(&wanted));wanted.monitor=4;assert(!qsdk_switch_valid(&wanted));
	puts("QSDK switch controls selfcheck passed: bounded results, masks, limiter and mirror validation");
}
