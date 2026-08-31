/* The game's 5-layer profile portrait, in one place.
 *
 * Three windows drew this independently — the Team Ops roster and
 * leaderboards, the Comms member list, and the raid viewer's commander HUD —
 * and only ONE of them validated the layer indices it was interpolating into
 * an image path.
 *
 * That matters more than a normal duplication, because a portrait is not our
 * data. `pfpClientRenderAttributes` is a free-form string that each player
 * writes about THEMSELVES on chain, and every one of these surfaces renders
 * OTHER players: the roster shows the guild, the leaderboards show the
 * galaxy, and the raid HUD shows the person currently attacking you. That
 * last one is the most adversarial view in the app and it had no check at all.
 *
 * An <img> src makes the usual tricks inert, but an unchecked value still
 * means a burst of failed loads and a request this window never meant to
 * make, shaped by somebody else.
 */
(function (root) {
  'use strict';

  // Back-to-front, exactly as the webapp paints it.
  var PFP_LAYERS = ['background', 'arms', 'body', 'neck', 'head'];

  // How many pieces of art ship for each layer. Asserted against the files on
  // disk by the units suite, so this cannot drift from what exists.
  var PFP_PART_COUNTS = {
    head: 87, neck: 10, body: 57, arms: 34, background: 6,
  };

  /* A valid layer index for a given part.
   *
   * `'01'`, `1.5`, `0` and `'../x'` are all rejected — the last is why this
   * exists, the others are why it checks the REAL range rather than "some
   * small number". The art is 1-BASED: the webapp generates
   * `floor(random * count) + 1` and there is no `pfp_<part>_0.png`, so a 0 is
   * a guaranteed 404 rather than a portrait.
   */
  function isLayer(part, v) {
    var max = PFP_PART_COUNTS[part];
    return !!max && typeof v === 'number' && isFinite(v)
      && Math.floor(v) === v && v >= 1 && v <= max;
  }

  /* Where a layer's art lives.
   *
   * The path shape in ONE place. The appearance picker built it a fourth time
   * for its thumbnails — from indices the app clamps itself, so not the
   * untrusted case, but a fourth spelling of a path is still a fourth thing to
   * change when the art moves.
   */
  function layerSrc(part, idx) {
    return 'img/pfp/' + part + '/pfp_' + part + '_' + idx + '.png';
  }

  /* Paint a portrait into `frame`, or a placeholder if there is nothing to
   * paint. Returns the frame so callers can wrap it in whatever the
   * surrounding list wants.
   *
   * Deliberately all-or-nothing on `head`: a portrait missing its face is not
   * a partial portrait, it is a broken one, and the game shows the
   * placeholder instead so lists keep their shape.
   */
  function fillPortrait(frame, attrsJson, makeImg) {
    var img = makeImg || function () { return document.createElement('img'); };
    var pfp = null;
    if (attrsJson) { try { pfp = JSON.parse(attrsJson); } catch (e) { pfp = null; } }
    if (pfp && typeof pfp === 'object' && isLayer('head', pfp.head)) {
      PFP_LAYERS.forEach(function (part) {
        if (!isLayer(part, pfp[part])) return;
        var im = img();
        im.className = 'pfp-viewer-layer';
        im.src = layerSrc(part, pfp[part]);
        im.alt = '';
        frame.appendChild(im);
      });
    } else {
      var ph = img();
      ph.className = 'pfp-viewer-layer';
      ph.src = 'img/portrait-placeholder.png';
      ph.alt = '';
      frame.appendChild(ph);
    }
    return frame;
  }

  root.StructsPfp = {
    PFP_LAYERS: PFP_LAYERS,
    PFP_PART_COUNTS: PFP_PART_COUNTS,
    isLayer: isLayer,
    layerSrc: layerSrc,
    fillPortrait: fillPortrait,
  };
})(typeof window !== 'undefined' ? window : globalThis);
