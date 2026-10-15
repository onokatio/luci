/* musl 1.1 lacks qsort_r(); the build supplies musl 1.2.5's implementation. */
#include <stddef.h>
void qsort_r(void *, size_t, size_t, int (*)(const void *, const void *, void *), void *);
