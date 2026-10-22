#!/usr/bin/env python3
"""Paired analysis of a load/ab.sh session: each scenario's A and B runs of one round ran back to back,
so their ratio cancels drift in host state between rounds (load, memory, the growing database).

Usage: python3 load/ab-paired.py load/results/ab-<session>.txt [run_order:reason ...]
       Each run_order:reason marks one run invalid (e.g. "31:host suspended"); its pair is excluded.
Prints, per scenario: every pair (RPS, p95, p99, rejected share), then over the valid pairs the
B/A RPS ratio min/median/max and geometric mean, how many pairs B won, an exact two-sided sign-flip
permutation p-value on the log ratios, and the median p95/p99 ratios. Standard library only.
"""
import itertools
import math
import statistics as st
import sys

index, *marks = sys.argv[1:]
invalid = dict((int(m.split(':', 1)[0]), m.split(':', 1)[1]) for m in marks)
lines = [l.split() for l in open(index) if l[:1].isdigit() and len(l.split()) == 17]
labels = [l.split()[1] for l in open(index) if l.startswith(('A ', 'B '))]
runs = [dict(n=int(r[0]), phase=r[1], label=r[2], sc=r[3], id=r[5], rps=float(r[7]), p95=float(r[9]),
             p99=float(r[10]), err=int(r[11]), acc=int(r[12]), rej=int(r[13]), viol=int(r[16])) for r in lines]
measured = [r for r in runs if r['phase'] == 'measure']
pairs = [(measured[i], measured[i + 1]) for i in range(0, len(measured), 2)]
rejected = lambda r: 100 * r['rej'] / (r['acc'] + r['rej']) if r['acc'] + r['rej'] else 0.0
a_label, b_label = labels

for scenario in dict.fromkeys(r['sc'] for r in measured):
    print(f'== {scenario} ({b_label} / {a_label})')
    print('round  A run        B run        A rps   B rps  ratio  p95 A->B          p99 A->B          rejected% A/B  status')
    ratios, p95s, p99s = [], [], []
    for rnd, (x, y) in enumerate((p for p in pairs if p[0]['sc'] == scenario), 1):
        a, b = (x, y) if x['label'] == a_label else (y, x)
        bad = [f"run {r['n']}: {invalid[r['n']]}" for r in (a, b) if r['n'] in invalid]
        ratio = b['rps'] / a['rps']
        print(f"{rnd:>5}  {a['n']:>2} {a['id']}  {b['n']:>2} {b['id']}  {a['rps']:>6.1f}  {b['rps']:>6.1f}  {ratio:.3f}"
              f"  {a['p95']:>7.1f}->{b['p95']:<7.1f}  {a['p99']:>8.1f}->{b['p99']:<7.1f}  {rejected(a):4.1f}/{rejected(b):4.1f}"
              f"     {'EXCLUDED (' + '; '.join(bad) + ')' if bad else 'ok'}")
        if not bad:
            ratios.append(ratio)
            p95s.append(b['p95'] / a['p95'])
            p99s.append(b['p99'] / a['p99'])
    if not ratios:
        print('no valid pairs\n')
        continue
    logs = [math.log(r) for r in ratios]
    observed = abs(sum(logs))
    flips = list(itertools.product((1, -1), repeat=len(logs)))
    extreme = sum(abs(sum(s * l for s, l in zip(signs, logs))) >= observed - 1e-12 for signs in flips)
    print(f'valid pairs {len(ratios)}: ratio min {min(ratios):.3f}  median {st.median(ratios):.3f}  max {max(ratios):.3f}'
          f'  geometric mean {math.exp(st.mean(logs)):.3f}; {b_label} faster in {sum(r > 1 for r in ratios)}/{len(ratios)}'
          f'; exact two-sided permutation p = {extreme}/{len(flips)} = {extreme / len(flips):.4f}')
    print(f'median p95 ratio {st.median(p95s):.3f}, median p99 ratio {st.median(p99s):.3f}\n')

print('errors by run:', {r['n']: r['err'] for r in runs if r['err']} or 'none',
      '| invariant violations, all runs:', sum(r['viol'] for r in runs))
