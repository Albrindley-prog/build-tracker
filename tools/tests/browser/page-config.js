// Which Stock Control page the browser suites test. PAGE=website tests stock-control/ (the neutral page generated for the
// website); anything else tests stock-control-pd-stevens/ (the master).
const path = require('path');
const root = path.resolve(__dirname, '..', '..', '..');
const WEBSITE = process.env.PAGE === 'website';
module.exports = {
  WEBSITE,
  PAGE_PATH: WEBSITE ? '/stock-control/' : '/stock-control-pd-stevens/',
  APP: path.join(root, WEBSITE ? 'stock-control' : 'stock-control-pd-stevens', 'index.html').split(path.sep).join('/'),
  COMPANY: WEBSITE ? 'Your company name' : 'PD Stevens & Sons Ltd',   // the receipt heading default
};
