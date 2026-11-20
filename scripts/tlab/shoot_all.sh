#!/usr/bin/env bash
# shoot_all.sh OUTDIR [W] — every section and view of the Telemetry card, plus split and narrow states.
set -euo pipefail
OUT="$1"; W="${2:-1180}"; mkdir -p "$OUT"; S="$(dirname "$0")/shot.sh"
shoot() { bash "$S" "$OUT/$1.png" "$2" "${3:-$W}" "${4:-1500}" "${5:-}" >/dev/null & }
shoot overview '{}'
shoot overview-7d '{"win":"7"}'
shoot acquisition '{"page":"acquisition"}'
shoot onboarding-phases '{"page":"onboarding"}'
shoot onboarding-steps '{"page":"onboarding","view":"steps"}'
wait
shoot onboarding-runs '{"page":"onboarding","view":"runs"}'
shoot onboarding-timing '{"page":"onboarding","view":"timing"}'
shoot onboarding-impact '{"page":"onboarding","view":"impact"}'
shoot engagement-activation '{"page":"engagement"}'
shoot engagement-retention '{"page":"engagement","view":"retention"}' 1180 2000
wait
shoot engagement-distributions '{"page":"engagement","view":"distributions"}' 1180 2400
shoot players-signups '{"page":"players"}'
shoot players-runs '{"page":"players","view":"runs"}'
shoot players-stopped '{"page":"players","view":"stopped"}'
shoot guilds '{"page":"guilds"}'
shoot trends '{"page":"trends"}' 1180 1700
wait
shoot trends-daily '{"page":"trends","view":"daily"}'
shoot data '{"page":"data"}' 1180 2000
shoot split-guild-overview '{"compare":"guild"}' 1180 1800
shoot split-guild-onboarding '{"compare":"guild","page":"onboarding","view":"steps"}'
shoot split-tutorial-engagement '{"compare":"tutorial","page":"engagement"}'
wait
shoot narrow-overview '{}' 560 1500
shoot narrow-onboarding '{"page":"onboarding"}' 560 1500
shoot cold-reading '{}' 1180 700 reading
shoot filtered-guild '{"guild":"0-5","page":"acquisition"}'
wait
shoot split-version-phases '{"compare":"version","page":"onboarding"}'
shoot narrow-split-overview '{"compare":"guild"}' 560 1500
shoot narrow-trends '{"page":"trends"}' 560 1500
shoot narrow480-overview '{}' 480 1500
shoot narrow480-steps-split '{"page":"onboarding","view":"steps","compare":"version"}' 480 1500
shoot guilds-focused '{"page":"guilds","guild":"0-5"}'
wait
ls "$OUT" | wc -l
