---
title: "Compilation cost study · cppgm inception"
description: "A technical look at compilation costs in cppgm vs. Clang."
eyebrow: "Native compilation study · 16 November 2026"
---

# Compile time comparison

We profiled cppgm and Clang compiling 16 LLVM source units at `-O2`. The sample pointed to semantic analysis and optimization as major contributors to the instruction gap.

> **Separate from the browser demo.** The profile used native cppgm 0.9.3 and Clang 22.1.2 on a Xeon E5-2696 v4.

<!-- section: totals | Whole compile -->

## The measured totals

Across the sample, callgrind counted 214.7 billion instructions for Clang and 59.8 billion for cppgm: about **3.6×** as many for Clang. A separate perf run measured 288.4 billion cycles for Clang and 52.3 billion for cppgm, about **5.5×** as many. Cycle counts came from a host under load.

<!-- stats -->

| Metric | Value | Unit |
| --- | --- | --- |
| Clang instructions | 214.7 | G |
| cppgm instructions | 59.8 | G |
| Sample | 16 | units |

<!-- note -->

G = billions. Counts are summed over the sample, not per source file. Instruction and cycle figures above come from different runs.

<!-- section: phases | Explore the phases -->

## A closer look at the gap

The front end accounts for the largest share of the attributed gap. Select a metric to compare each compiler’s phase costs and see how much each phase contributes.

<!-- phase-chart -->

| Phase | Clang instructions | cppgm instructions | Clang cycles | cppgm cycles | Description |
| --- | --- | --- | --- | --- | --- |
| Front end | 126.3 | 42.2 | 168.6 | 37.3 | Lexing, preprocessing, parsing and semantic analysis |
| IR generation | 12.1 | 2.6 | 15.5 | 2.4 | Includes cppgm lowering and object writing |
| Optimizer | 49.8 | 12.2 | 67.9 | 10.8 | Optimization passes and analyses |
| Back end | 26.0 | 2.1 | 23.9 | 1.9 | Instruction selection, allocation and encoding |

<!-- note -->

Phase figures are estimates. A separate perf run measured 214.4 G and 59.1 G instructions for Clang and cppgm.
<!-- section: findings | What the profiles suggest | cards -->

## The costs are uneven

### Semantic analysis

Profile attribution points to type representation, expression bookkeeping, lookup, overload resolution and templates as substantial costs. Some of this work supports diagnostics and language features.

### Optimization

LLVM ran more passes and analyses in this sample. Its optimizer was estimated at 49.8 G instructions versus 12.2 G for cppgm. Similar IR sizes do not establish equivalent optimization or output quality.

### Lexing and parsing

There were only minor differences in lexing and parsing. Profiling found more instructions but fewer sampled cycles in cppgm.

<!-- section: improvements | Potential improvements -->

## Reduce repeated work

The opportunities below use different measurements for each compiler. The estimates show where work could be reduced; they are not measured gains from new patches.

<!-- id: clang-improvements -->

### Clang and LLVM

Each figure is Clang’s attributed cost minus cppgm’s cost for the same mechanism over 16 `-O2` units. Percentages use Clang’s 214.7 G callgrind instructions.

*Selected comparison scenarios · G = billion instructions*

| Proposed change | Cost difference | Clang total |
| --- | --- | --- |
| Share type information and reduce spelling records | 22.4 G | 10.4% |
| Direct context navigation and cached context facts | 15.9 G | 7.4% |
| Reject overload candidates earlier | 11.4 G | 5.3% |
| Reuse canonical template substitutions | 9.6 G | 4.5% |
| Reuse checked facts for instantiated members | 6.7 G | 3.1% |
| Simpler IR attributes, value handles and metadata | 20.2 G | 9.4% |
| Skip unchanged passes and retain valid analyses | 19.5 G | 9.1% |

Other suggestions include reducing expression bookkeeping, caching diagnostic state, running warning analyses only when needed, and selecting machine instructions more directly. Note that Clang uses type spelling to report rejected candidates and in warning analysis, so some of these changes might imply changes to warnings and errors.

These cost differences do not form a set of tested patches, and cppgm’s cost does not prove that Clang can match it while keeping its capabilities. Profile-guided optimization and BOLT might improve code layout, but their effects were not measured here.

<!-- id: gcc-improvements -->

### GCC

GCC’s `-ftime-report` timers for a 60-unit `-O0` run attributed about 16% of its compile to overload resolution, 27% to template instantiation and body checking, 24% to the back end, and 5% to garbage collection. These are timer shares, not measured savings or estimates from the 16-unit `-O2` comparison.

This implies that GCC compile time improvements should focus primarily on three areas: filtering overload candidates earlier, reusing template and type information, and simplifying the `-O0` back end. Writing object files directly avoids a separate assembler. Arenas freed after each phase could replace garbage collection.

<!-- section: method | Method & limits | faq -->

## Questions & answers

We compiled 16 LLVM 22.1.2 source units with CI flags and libstdc++ 15 headers. The four largest units accounted for 66% of Clang’s instructions and 60% of cppgm’s. Clang was built at `-O3`, statically linked, with symbols.

### What was measured and estimated?

We used Callgrind to count instructions and profile functions, and perf to count instructions and cycles. Clang’s phase costs come from separate compiler modes and subtraction. cppgm’s phase costs use its `--stats` timing shares; its optimizer cost is the `-O2` back half minus `-O0` lowering and object writing. Assigning shared helper costs to callers is an approximation, and inlined calls can be missing from call counts. The full raw profiles are not published here.

### How comparable was the work?

Both compilers handled similar amounts of work, but the counts were not identical. On 12 units, Clang recorded 70,419 class instantiations and cppgm 65,107. Before optimization, the IR counts were 472,926 LLVM instructions and 477,253 LowIR instructions; afterwards they were 195,009 and 210,469. The representations and counting methods differ. These counts alone do not establish equal semantics, diagnostics or generated code quality.

<!-- id: lexing-evidence -->

### How do lexing and parsing compare?

cppgm used more instructions but fewer sampled cycles. Its parser also classifies names and builds a syntax tree; Clang assigns much of that work to semantic analysis. The table counts work within the lexer and parser functions, without assigning shared helper costs to them.

*Billions · 16 units at -O2 · Clang / cppgm*

| Phase | Instructions | Sampled cycles |
| --- | --- | --- |
| Lexing and preprocessing | 8.26 / 11.67 | 4.97 / 4.52 |
| Parsing | 3.66 / 8.41 | 5.57 / 3.99 |

Instructions come from Callgrind; cycles come from sampled user-mode profiles on the loaded host. These sampled cycle estimates use a different method from the phase chart and are not elapsed times.

### Would using LLVM as a backend keep cppgm’s compile-time advantage?

It could keep part of it. Combining cppgm’s front-end cost with LLVM’s pipeline cost gives an estimate of 131.7–148.2 G cycles at `-O2`, compared with 288.4 G for Clang and 52.3 G for cppgm. We have not built or timed this combination. The model uses LLVM’s cost on Clang’s IR and assumes a range of IR generation costs. cppgm-produced LLVM IR would also need appropriate metadata for comparable output.

### Do these results predict runtime performance or code quality?

No. We measured the cost of compilation, not the speed or quality of the generated programs. Clang provides broader diagnostics, tooling and target support, which can add work. Compilation ratios also depend on the source, flags, compiler versions and hardware.

