/* Keep the native capture and browser replay on the same source timestamp. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <time.h>

static const time_t source_epoch = 1735689600;

time_t time(time_t *result)
{
    if (result)
        *result = source_epoch;
    return source_epoch;
}

int clock_gettime(clockid_t clock, struct timespec *result)
{
    if (clock == CLOCK_REALTIME) {
        result->tv_sec = source_epoch;
        result->tv_nsec = 0;
        return 0;
    }
    int (*original)(clockid_t, struct timespec *) = dlsym(RTLD_NEXT, "clock_gettime");
    return original(clock, result);
}
