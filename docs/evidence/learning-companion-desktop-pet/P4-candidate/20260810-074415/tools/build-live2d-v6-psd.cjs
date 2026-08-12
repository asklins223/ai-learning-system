const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { initializeCanvas, readPsd, writePsd } = require('ag-psd');

const root = path.resolve(__dirname, '..');
const templatePath = path.join(root, 'seethrough-restored-candidate-live2d-v2.psd');
const packPath = path.join(root, 'live2d-layer-pack-1024-shoe-wrap-tail-fit-v6');
const compositePath = path.join(root, 'seethrough-composite-shoe-wrap-tail-fit-v6.png');
const outputPath = path.join(root, 'seethrough-restored-candidate-live2d-v6-valid.psd');

const createImageData = (width, height) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

initializeCanvas(
  () => {
    throw new Error('Canvas access is not expected when useImageData is enabled');
  },
  createImageData,
);

function readPng(fileName) {
  const png = PNG.sync.read(fs.readFileSync(path.join(packPath, fileName)));
  if (png.width !== 1024 || png.height !== 1024) {
    throw new Error(`${fileName} must be 1024x1024, got ${png.width}x${png.height}`);
  }
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data),
  };
}

function readComposite() {
  const png = PNG.sync.read(fs.readFileSync(compositePath));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data),
  };
}

const psd = readPsd(fs.readFileSync(templatePath), { useImageData: true });
const templateLayers = new Map(psd.children.map((layer) => [layer.name, layer]));

function makeLayer(name, fileName, templateName = name) {
  const template = templateLayers.get(templateName) || {};
  return {
    ...template,
    name,
    left: 0,
    top: 0,
    right: 1024,
    bottom: 1024,
    hidden: false,
    opacity: 1,
    imageData: readPng(fileName),
  };
}

// Cubism renders this list from back to front. The rear shoe rims sit behind the
// legs, while the boot bodies sit in front, so the legs visibly enter the boots.
// The comet-tail cape is behind the coat body, hiding its root at the waist.
const layerSpecs = [
  ['back hair', '00-back-hair.png'],
  ['footwear-back', '03-footwear-back-v6.png', 'footwear'],
  ['tail-refined', '07-tail-refined-v6.png', 'tail-restored-candidate'],
  ['legwear', '01-legwear.png'],
  ['objects-restored-candidate', '07-objects-restored-candidate.png'],
  ['handwear-r', '02-handwear-r.png'],
  ['footwear-front', '03-footwear-front-v6.png', 'footwear'],
  ['handwear-l', '04-handwear-l.png'],
  ['neck', '05-neck.png'],
  ['topwear-tail-masked-candidate', '06-topwear-tail-masked-candidate.png'],
  ['ears-l', '08-ears-l.png'],
  ['ears-r', '09-ears-r.png'],
  ['face', '10-face.png'],
  ['nose', '11-nose.png'],
  ['mouth', '12-mouth.png'],
  ['eyewhite-r', '13-eyewhite-r.png'],
  ['eyewhite-l', '14-eyewhite-l.png'],
  ['irides-l', '15-irides-l.png'],
  ['irides-r', '16-irides-r.png'],
  ['eyebrow-l', '17-eyebrow-l.png'],
  ['eyewear', '18-eyewear.png'],
  ['eyebrow-r', '19-eyebrow-r.png'],
  ['eyelash-r', '20-eyelash-r.png'],
  ['eyelash-l', '21-eyelash-l.png'],
  ['front hair', '22-front-hair.png'],
  ['headwear', '23-headwear.png'],
];

psd.children = layerSpecs.map(([name, fileName, templateName]) =>
  makeLayer(name, fileName, templateName),
);
psd.imageData = readComposite();

const bytes = writePsd(psd, {
  generateThumbnail: false,
  invalidateTextLayers: true,
});
fs.writeFileSync(outputPath, Buffer.from(bytes));
process.stdout.write(`${outputPath}\n`);
