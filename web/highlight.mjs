import Prism from './vendor/prism.mjs';

// LowIR is cppgm's own text dialect. Keep its names distinct from LLVM IR.
// These are display tokens only; the compiler parses and validates the input.
Prism.languages.lowir = {
  comment: /\/\/[^\r\n]*/,
  string: {pattern: /"(?:\\.|[^"\\])*"/, greedy: true},
  symbol: {pattern: /@[A-Za-z_][\w.$:]*/, alias: 'function'},
  variable: /[%$][A-Za-z_][\w.$]*/,
  label: {pattern: /\^[A-Za-z_][\w.$]*/, alias: 'function'},
  'class-name': /\b(?:void|ptr|obj|v128|[iu](?:1|8|16|32|64|128)|f(?:16|32|64|80|128))\b/,
  keyword: /\b(?:declare|global|function|alias|object|slot|block|zero|as|debug_type|debug_scope|debug_local|assembly|equivalent_entry|assembly_function|assembly_global|code_label|target|exception_abi|import|export|const|copy|phi|addr|load|atomic_load|index|unary|binary|cmp|select|convert|vector|atomic_add_fetch|atomic_exchange|atomic_compare_exchange|va_arg|stack_alloc|stack_save|frame_address|read_mxcsr|call|exception|exception_selector|asm|store|atomic_store|atomic_thread_fence|atomic_signal_fence|va_start|stack_restore|write_mxcsr|copyobj|zeroinit|eh_try|eh_cleanup|eh_catch|eh_filter|eh_catch_all|eh_end|throw|resume|jump|branch|switch|indirect_jump|return|unreachable|typed|inbounds|volatile|nonnull|nowrap|exact)\b/,
  number: /(?:\b(?:nan|inf)\b|[+-]?\b(?:0x[\da-f]+(?:\.[\da-f]*)?(?:p[+-]?\d+)?|\d+(?:\.\d*)?(?:e[+-]?\d+)?))\b/i,
  operator: /->|=|[+*/&|!~?-]/,
  punctuation: /[{}\[\](),:<>]/,
};

// Prism's pinned Wasm grammar predates the current instruction spellings.
// Add the modern text names while retaining its strings, comments and labels.
Prism.languages.insertBefore('wasm', 'keyword', {
  instruction: {
    pattern: /\b(?:(?:i32|i64|f32|f64|v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2|local|global|table|memory|data|elem|ref|atomic)\.[a-z][\w.]*)\b/,
    alias: 'keyword',
  },
  'modern-keyword': {
    pattern: /\b(?:try_table|try|catch|catch_all|catch_ref|catch_all_ref|throw|throw_ref|rethrow|delegate|tag|return_call|return_call_indirect|call_ref|return_call_ref|br_on_null|br_on_non_null)\b/,
    alias: 'keyword',
  },
});

// The decoder renders Intel instructions after a hexadecimal byte offset.
Prism.languages.insertBefore('nasm', 'register', {
  instruction: {
    pattern: /(^[\t ]*(?:[\da-f]{6,16}[\t ]+)?)[a-z][\da-z]*(?=[\t ]|$)/im,
    lookbehind: true,
    alias: 'keyword',
  },
});

const languages = new Map([
  ['cpp', 'cpp'], ['c++', 'cpp'], ['c', 'c'], ['lowir', 'lowir'],
  ['wasm', 'wasm'], ['wat', 'wasm'], ['x86', 'nasm'], ['nasm', 'nasm'],
]);

export function highlight(code, language = 'cpp') {
  const text = String(code ?? '');
  const name = languages.get(language);
  return name ? Prism.highlight(text, Prism.languages[name], name) : Prism.util.encode(text);
}

export function highlightCode(element, code, language = 'cpp') {
  const name = languages.get(language) ?? 'text';
  for (const current of [...element.classList])
    if (current.startsWith('language-')) element.classList.remove(current);
  element.classList.add(`language-${name}`);
  // Prism escapes all input text before adding its own token spans.
  element.innerHTML = highlight(code, language);
}
