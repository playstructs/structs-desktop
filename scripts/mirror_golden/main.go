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
	"strconv"
)

type inverse struct {
	Range  uint64    `json:"range"`
	// ReadyAge[d-1] = smallest age with CalculateDifficulty(age, range) <= d,
	// or nil when no age reaches d.
	ReadyAge []*uint64 `json:"ready_age"`
}

// A completion as the chain judges it: HashBuildAndCheckDifficulty(input,
// proof, age, range) -> (valid, achieved).
type proofCase struct {
	Input    string `json:"input"`
	Proof    string `json:"proof"`
	Age      uint64 `json:"age"`
	Range    uint64 `json:"range"`
	Valid    bool   `json:"valid"`
	Achieved uint64 `json:"achieved"`
}

type golden struct {
	Source     string      `json:"source"`
	SourceSHA  string      `json:"source_sha256"`
	Difficulty [][3]uint64 `json:"difficulty"` // [age, range, difficulty]
	Inverse    []inverse   `json:"inverse"`
	Proofs     []proofCase `json:"proofs"`
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

	// Proofs: search nonces for hashes with 0..3 leading zeros, then judge
	// each (and a deliberately wrong proof) at several ages.
	var proofs []proofCase
	inputs := []string{"5-1MINE1000NONCE", "5-2REFINE2000NONCE", "5-3BUILD300NONCE", "9-1@2-1RAID400NONCE"}
	for _, prefix := range inputs {
		want := 0
		for n := 0; n < 200000 && want <= 3; n++ {
			input := prefix + strconv.Itoa(n)
			h := HashBuild(input)
			zeros := 0
			for zeros < len(h) && h[zeros] == '0' {
				zeros++
			}
			if zeros != want {
				continue
			}
			want++
			for _, age := range []uint64{0, 1, 10, 1000, 20000, 28000} {
				for _, r := range []uint64{125, 14000, 28000} {
					v, a := HashBuildAndCheckDifficulty(input, h, age, r)
					proofs = append(proofs, proofCase{input, h, age, r, v, a})
				}
			}
			v, a := HashBuildAndCheckDifficulty(input, HashBuild(input+"x"), 28000, 28000)
			proofs = append(proofs, proofCase{input, HashBuild(input + "x"), 28000, 28000, v, a})
		}
	}

	out := golden{Source: os.Getenv("GOLDEN_SOURCE"), SourceSHA: os.Getenv("GOLDEN_SHA"), Difficulty: cases, Inverse: inv, Proofs: proofs}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
