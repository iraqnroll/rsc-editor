// Render the canonical RSC world map with rsc-landscape's own painter, so ours
// can be compared against the reference rather than against memory.
//
// `drawPoints()` is stubbed out: it loads key icons from res/key/, which the
// published package ships empty. The sector raster is what we are comparing.
const fs = require('fs');
const path = require('path');
const { Landscape } = require('@2003scape/rsc-landscape');
const MapPainter = require('@2003scape/rsc-landscape/src/map-painter');

MapPainter.prototype.drawPoints = async function noPoints() {};
MapPainter.prototype.drawLabels = function noLabels() {};

const CACHE = process.argv[2];
const OUT = process.argv[3];
const read = (f) => fs.readFileSync(path.join(CACHE, f));

(async () => {
  const landscape = new Landscape();
  landscape.loadJag(read('land63.jag'), read('maps63.jag'));
  landscape.loadMem(read('land63.mem'), read('maps63.mem'));
  landscape.parseArchives();

  const canvas = await landscape.toCanvas({ objects: false, points: [], labels: [] });
  const buf = canvas.toBuffer ? canvas.toBuffer('image/png') : canvas.encodeSync('png');
  fs.writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} ${canvas.width}x${canvas.height} ${buf.length} bytes`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
