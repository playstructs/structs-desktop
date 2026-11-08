// Golden vectors for the mirror's chain rules, computed by the chain's OWN
// code. mirror_golden.sh copies structsd's x/structs/types/work.go next to
// this file (package renamed to main) and runs it, so every number below
// comes from CalculateDifficulty exactly as validators execute it.
//
// The inverse table is found by LINEAR scan — the definition of "the first
// age at which difficulty <= d" — so the Rust side's binary search is checked
// against ground truth rather than against another clever algorithm.
package main

import (
	"encoding/json"
	"os"
)

type inverse struct {
	Range  uint64    `json:"range"`
	// ReadyAge[d-1] = smallest age with CalculateDifficulty(age, range) <= d,
	// or nil when no age reaches d.
	ReadyAge []*uint64 `json:"ready_age"`
}

type golden struct {
	Source     string      `json:"source"`
	SourceSHA  string      `json:"source_sha256"`
	Difficulty [][3]uint64 `json:"difficulty"` // [age, range, difficulty]
	Inverse    []inverse   `json:"inverse"`
}

func main() {
	ranges := []uint64{0, 1, 2, 3, 5, 7, 10, 25, 50, 64, 100, 125, 225, 325, 1000, 5000, 28000, 100000}

	var cases [][3]uint64
	add := func(age, r uint64) {
		cases = append(cases, [3]uint64{age, r, uint64(CalculateDifficulty(age, r))})
	}
	for _, r := range ranges {
		for age := uint64(0); age <= 300; age++ {
			add(age, r)
		}
		for d := int64(-3); d <= 3; d++ {
			if a := int64(r) + d; a > 300 {
				add(uint64(a), r)
			}
		}
		// Deterministic spread out to 10x the range (an LCG, no seeds to drift).
		x := uint64(0x9E3779B97F4A7C15) ^ r
		span := r*10 + 1000
		for i := 0; i < 200; i++ {
			x = x*6364136223846793005 + 1442695040888963407
			add(x%span, r)
		}
	}
	// Extremes the u64 big-number path has to survive.
	add(^uint64(0), 28000)
	add(^uint64(0), ^uint64(0))
	add(1<<40, 1<<20)

	var inv []inverse
	for _, r := range ranges {
		row := inverse{Range: r, ReadyAge: make([]*uint64, 64)}
		limit := r + 2
		if limit < 4 {
			limit = 4
		}
		for age := uint64(0); age <= limit; age++ {
			got := CalculateDifficulty(age, r)
			for d := got; d <= 64; d++ {
				if row.ReadyAge[d-1] == nil {
					a := age
					row.ReadyAge[d-1] = &a
				}
			}
		}
		inv = append(inv, row)
	}

	out := golden{Source: os.Getenv("GOLDEN_SOURCE"), SourceSHA: os.Getenv("GOLDEN_SHA"), Difficulty: cases, Inverse: inv}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
