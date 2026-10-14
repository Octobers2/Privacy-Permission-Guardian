import { footer, header } from './common.js';

// Pages with no script of their own (the 404) still get the shared header and footer.
document.getElementById('top').replaceChildren(header(''));
document.getElementById('bottom').replaceChildren(footer());
