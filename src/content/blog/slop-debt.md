---
title: "Slop debt has no author"
description: "Tech debt comes from decisions you can trace back. Slop debt comes from code nobody decided on, and it's spread too evenly for refactoring to reach."
date: 2026-10-25
tags:
  - ai
  - llm
  - tech-debt
  - code-quality
  - software-engineering
---

Technical debt is traceable. Someone traded quality for speed, the trade is recorded somewhere, and the bill arrives at a predictable spot in the code. That's why a senior engineer can walk through an old codebase and say which modules are rotten and roughly why.

Slop debt doesn't behave that way. It piles up when a language model writes most of the code, the people reviewing it don't fully understand it, and a green test run counts as permission to merge. The result compiles and mostly runs. It also has no author in the usual sense, because nobody decided what it should look like.

## Nobody chose any of it

A tech debt shortcut is a decision with a paper trail. Someone hardcoded a value or copied a function instead of extracting it, and you can ask them why or read the commit message. The reason may be bad, but it exists and you can recover it.

Slop has no such reason to recover. The naming, the error handling, and the wrapper layers that add nothing were each produced fresh for every file, and the model carries nothing over from the previous one. Take two functions that do the same job in different ways, written six weeks apart. In a hand-built codebase that points to two people who disagreed. Here it points to nobody, because whoever was at the keyboard was approving output and not enforcing a convention.

Calling this tech debt at a larger scale misses what makes it hard to work in: the pieces contradict each other.

## The model learns from its own output

Ordinary debt scales with the amount of code: more features on a shaky base, more shakiness. Slop debt has a feedback loop. Every new generation reads the existing files as context, and those files are the mess. After a few hundred files that each make sense alone and contradict each other together, the model has no way to tell which style is the intended one. It reproduces whichever it happened to see, or it invents a third error handling approach next to the first two.

So each round of generation adds debt and also makes the next round add it faster, in the same form. Humans copy nearby code too, and a junior engineer will imitate a bad pattern as readily as a good one. The difference is that a person eventually gets irritated by the inconsistency and goes to fix it. The model has no preference to be irritated by, and the thousandth copy of a poor idea comes out as confident as the first.

## Debugging and review both lose their footing

Bad code written by a human still has a structure you can follow from the symptom back to the cause. Slop has several overlapping structures. You open a file looking for a bug and find three retry strategies, two logging conventions, and a helper that reimplements something the standard library already provides. Asking why gets you nothing, since nobody had a reason in mind when it was written.

Review doesn't help much either. A reviewer reads a diff and checks whether it looks right, and generated code usually looks right. Its flaw is in how it relates to the rest of the system, and a diff shows only the lines that changed, not everything those lines ought to agree with.

## Refactoring needs somewhere to start

Incremental cleanup works on ordinary debt because the debt has a location. You pick a module, put tests around it, tidy it, and move to the next one.

Slop debt is spread thinly through everything, so there's no module to pick. Tidying one area doesn't make the system more coherent while the neighboring areas keep producing inconsistency at the rate you remove it. Past a certain size I think the realistic option is a rewrite, with a person making the architectural decisions and the model working inside a structure they designed.

## I don't have a fix

The usual suggestions are strict review, treating the model as a junior engineer, and curating what goes into its context. Some of them help a little. None has prevented slop debt in the codebases I've watched closely enough to have a view on.

I'd like to offer something you could put into practice next week, but I don't have it. Code is being produced faster than teams are building the habits that keep it consistent, and slop debt accumulates in that gap. More software will be written this way, and I'm not aware of tooling that can enforce architectural coherence at that pace. Many teams will hit this before they're ready, and rewrites will come up more often than anyone is budgeting for.
