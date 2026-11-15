/* Qualification only: reproduce source timestamps without changing monotonic clocks. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <time.h>
time_t time(time_t *result) {
    const time_t epoch = 1735689600; /* 2025-01-01 00:00:00 UTC */
    if (result) *result = epoch;
    return epoch;
}
int clock_gettime(clockid_t clock, struct timespec *result) {
    if (clock == CLOCK_REALTIME) {
        result->tv_sec = 1735689600;
        result->tv_nsec = 0;
        return 0;
    }
    int (*original)(clockid_t, struct timespec *) = dlsym(RTLD_NEXT, "clock_gettime");
    return original(clock, result);
}
