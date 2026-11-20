#!/usr/bin/env bash
# Telemetry lab: frontend/_harness_tlab.html = the board harness opened on ONE
# Telemetry card whose params come from the URL, for headless screenshots.
#   bash scripts/make_harness.sh && bash scripts/tlab/make_tlab.sh
#   http://127.0.0.1:8899/_harness_tlab.html?view=terminal&card=onboarding-1&p=<urlencoded JSON params>[&cold=reading|done]
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f frontend/_harness.html ] || { echo "run scripts/make_harness.sh first"; exit 1; }
python3 - <<'PY'
import re
src = open('frontend/_harness.html').read()
inject = """<script>
(function(){var q=new URLSearchParams(location.search);var p={};try{p=JSON.parse(q.get('p')||'{}')}catch(e){}
window.__HARNESS_LAYOUT__={version:3,cards:[{id:'onboarding-1',type:'onboarding',params:p,w:3}]};
if(q.get('cold'))window.__HARNESS_OB_COLD__=q.get('cold');
try{localStorage.clear()}catch(e){}
})();
</script>
"""
out = src.replace('<head>', '<head>\n' + inject, 1)
open('frontend/_harness_tlab.html', 'w').write(out)
PY
echo "wrote frontend/_harness_tlab.html"
