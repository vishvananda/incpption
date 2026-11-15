/* Copyright 2020 The Emscripten Authors. All rights reserved.
 * Emscripten is available under the MIT and University of Illinois/NCSA
 * licenses. See the Emscripten notices in the frozen SDK licenses directory.
 * Adapted from system/lib/compiler-rt/emscripten_setjmp.c: use the standard
 * longjmp intrinsic when the compiler has no __builtin_wasm_throw intrinsic.
 */
#include <stdint.h>
#include <setjmp.h>

struct jump_buffer {
    void *invocation;
    uint32_t label;
    struct { void *environment; int value; } argument;
};
void __wasm_setjmp(void *environment, uint32_t label, void *invocation) {
    struct jump_buffer *buffer = environment;
    buffer->invocation = invocation;
    buffer->label = label;
}
uint32_t __wasm_setjmp_test(void *environment, void *invocation) {
    struct jump_buffer *buffer = environment;
    return buffer->invocation == invocation ? buffer->label : 0;
}
_Noreturn void __wasm_longjmp(void *environment, int value) {
#if __has_builtin(__builtin_wasm_throw)
    struct jump_buffer *buffer = environment;
    buffer->argument.environment = environment;
    buffer->argument.value = value ? value : 1;
    __builtin_wasm_throw(1, &buffer->argument);
#else
    longjmp((struct __jmp_buf_tag *)environment, value);
#endif
}
