import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

const outDir = new URL('../public/puppets/rabbit/', import.meta.url);
const tmpDir = new URL('../.tmp-rabbit-puppet/', import.meta.url);

const robe = '#2d275f';
const robeDeep = '#171431';
const robeWine = '#4f214f';
const gold = '#c79243';
const goldLight = '#f2c66f';
const fur = '#e8dfd2';
const furWarm = '#c8aa85';
const furShadow = '#7b604a';
const pink = '#b97f83';
const ink = '#2b221d';

function defs() {
  return `
    <defs>
      <linearGradient id="robeGrad" x1="20%" y1="0%" x2="78%" y2="100%">
        <stop offset="0%" stop-color="${robeWine}"/>
        <stop offset="42%" stop-color="${robe}"/>
        <stop offset="100%" stop-color="${robeDeep}"/>
      </linearGradient>
      <linearGradient id="furGrad" x1="18%" y1="0%" x2="88%" y2="100%">
        <stop offset="0%" stop-color="#fffaf0"/>
        <stop offset="45%" stop-color="${fur}"/>
        <stop offset="100%" stop-color="${furWarm}"/>
      </linearGradient>
      <linearGradient id="furDarkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${fur}"/>
        <stop offset="100%" stop-color="${furShadow}"/>
      </linearGradient>
      <linearGradient id="trimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#76511e"/>
        <stop offset="45%" stop-color="${goldLight}"/>
        <stop offset="100%" stop-color="#8a5d22"/>
      </linearGradient>
      <radialGradient id="eyeGrad" cx="45%" cy="35%" r="70%">
        <stop offset="0%" stop-color="#fff3b0"/>
        <stop offset="42%" stop-color="#4b2c14"/>
        <stop offset="100%" stop-color="#100a07"/>
      </radialGradient>
      <filter id="paintNoise" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.036" numOctaves="4" seed="7" result="noise"/>
        <feColorMatrix in="noise" type="saturate" values="0" result="monoNoise"/>
        <feComponentTransfer in="monoNoise" result="grain">
          <feFuncA type="table" tableValues="0 0.12"/>
        </feComponentTransfer>
        <feComposite in="grain" in2="SourceAlpha" operator="in" result="grainClip"/>
        <feBlend in="SourceGraphic" in2="grainClip" mode="multiply"/>
      </filter>
      <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="#120b08" flood-opacity="0.35"/>
      </filter>
      <style>
        .outline { stroke: ${ink}; stroke-width: 5.5; stroke-linecap: round; stroke-linejoin: round; }
        .fine { stroke: ${ink}; stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; fill: none; opacity: 0.72; }
        .trim { stroke: url(#trimGrad); stroke-width: 10; stroke-linecap: round; stroke-linejoin: round; fill: none; }
        .trimFine { stroke: ${goldLight}; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; fill: none; opacity: 0.82; }
        .star { fill: ${goldLight}; opacity: 0.9; }
        .dot { fill: ${goldLight}; opacity: 0.62; }
      </style>
    </defs>
  `;
}

function star(x, y, r = 4, rot = 0) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const a = rot + Math.PI * 2 * i / 10 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.38;
    pts.push(`${(x + Math.cos(a) * rr).toFixed(1)},${(y + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `<polygon class="star" points="${pts.join(' ')}"/>`;
}

function robeStars(seed, width, height, count) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const x = 24 + rand() * (width - 48);
    const y = 32 + rand() * (height - 64);
    if (i % 7 === 0) out += star(x, y, 3.2 + rand() * 4.6, rand() * Math.PI);
    else out += `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1.3 + rand() * 2.2).toFixed(1)}"/>`;
  }
  return out;
}

function bodySvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="760" height="1010" viewBox="0 0 760 1010">
      ${defs()}
      <g filter="url(#softShadow)">
        <path class="outline" fill="url(#furGrad)" d="M374 184 C 356 94 379 31 427 13 C 451 62 457 132 439 203 Z"/>
        <path class="outline" fill="url(#furGrad)" d="M438 207 C 447 112 489 52 537 44 C 550 101 531 172 489 229 Z"/>
        <path fill="${pink}" opacity="0.58" d="M399 169 C 391 105 405 59 426 39 C 437 81 439 130 429 181 Z"/>
        <path fill="${pink}" opacity="0.5" d="M461 195 C 471 124 496 78 526 62 C 531 110 513 166 486 209 Z"/>
        <path class="fine" d="M422 37 C 434 80 435 139 423 181 M526 63 C 524 118 504 171 479 205"/>

        <path class="outline" fill="url(#furGrad)" d="M381 181 C 446 132 555 163 594 241 C 635 321 572 402 483 398 C 408 394 346 339 336 270 C 331 235 346 204 381 181 Z"/>
        <path fill="url(#furDarkGrad)" opacity="0.42" d="M418 325 C 464 342 528 333 572 286 C 559 360 504 394 445 379 C 406 369 378 347 358 313 C 374 320 394 323 418 325 Z"/>
        <path class="fine" d="M448 235 C 481 220 529 227 562 252 M438 285 C 469 303 520 300 555 276 M389 224 C 366 243 359 270 365 298"/>
        <path fill="#f3eadc" d="M518 274 C 560 266 594 284 608 313 C 566 331 528 323 502 297 Z"/>
        <path class="outline" fill="url(#eyeGrad)" d="M507 224 C 520 215 536 218 544 230 C 533 238 516 238 507 224 Z"/>
        <circle cx="526" cy="225" r="4.2" fill="#fff7ca"/>
        <path class="fine" d="M579 274 C 599 282 617 296 628 310 M580 289 C 604 292 628 301 646 315 M573 303 C 594 313 612 328 623 346"/>
        <path class="fine" d="M585 254 C 604 245 627 243 647 250 M590 263 C 611 260 633 263 649 273"/>
        <path fill="${ink}" d="M592 259 C 612 255 623 263 623 275 C 609 279 595 273 592 259 Z"/>

        <path class="outline" fill="url(#robeGrad)" filter="url(#paintNoise)" d="M225 325 C 276 262 365 247 436 291 C 520 342 573 450 609 613 C 638 743 669 821 721 883 C 640 954 497 987 353 952 C 221 921 119 866 75 771 C 41 697 57 611 116 548 C 159 503 175 387 225 325 Z"/>
        <path fill="#0b1223" opacity="0.45" d="M338 398 C 423 446 485 561 511 717 C 533 848 584 911 660 927 C 559 975 407 969 299 918 C 354 811 377 586 338 398 Z"/>
        <path class="trim" d="M229 330 C 204 428 192 553 178 696 C 168 799 130 860 74 879"/>
        <path class="trim" d="M310 304 C 333 404 331 515 320 631 C 306 779 287 871 251 930"/>
        <path class="trim" d="M429 308 C 503 411 554 578 591 753 C 611 846 648 900 717 891"/>
        <path class="trim" d="M120 552 C 213 604 337 625 479 614"/>
        <path class="trimFine" d="M199 360 C 234 385 276 398 323 398 M185 685 C 289 731 444 746 599 720 M284 919 C 401 953 544 946 681 897"/>
        <g clip-path="url(#robeClip)">
        </g>
        <clipPath id="robeClip">
          <path d="M225 325 C 276 262 365 247 436 291 C 520 342 573 450 609 613 C 638 743 669 821 721 883 C 640 954 497 987 353 952 C 221 921 119 866 75 771 C 41 697 57 611 116 548 C 159 503 175 387 225 325 Z"/>
        </clipPath>
        <g clip-path="url(#robeClip)">
          ${robeStars(27, 720, 920, 118)}
          <path class="trimFine" opacity="0.5" d="M96 806 C 206 847 392 862 624 819 M134 731 C 257 781 435 786 631 755 M154 644 C 276 690 439 693 591 667"/>
        </g>

        <path class="outline" fill="url(#furGrad)" d="M474 912 C 528 894 594 910 637 947 C 591 978 516 979 462 948 C 455 934 459 921 474 912 Z"/>
        <path class="outline" fill="url(#furGrad)" d="M252 905 C 301 890 361 903 400 938 C 357 970 288 972 238 947 C 230 930 234 915 252 905 Z"/>
        <path class="fine" d="M487 934 C 525 949 583 949 621 935 M263 929 C 300 945 352 946 386 932"/>
        <path class="fine" d="M388 180 C 431 198 464 235 477 280 M360 209 C 404 230 431 265 444 311 M405 162 C 421 185 423 218 413 247"/>
      </g>
    </svg>`;
}

function sleeveSvg(width, height, variant) {
  const wide = variant === 'upper';
  const bodyPath = wide
    ? 'M84 38 C 147 6 218 38 241 109 C 267 190 248 301 199 418 C 141 448 63 428 33 369 C 56 260 49 111 84 38 Z'
    : 'M80 28 C 133 8 192 33 214 89 C 241 158 218 266 170 345 C 120 372 55 355 27 309 C 47 213 43 84 80 28 Z';
  const cuffPath = wide
    ? 'M54 363 C 96 402 156 415 205 390 C 218 410 211 438 189 452 C 132 478 56 454 25 400 C 29 382 38 371 54 363 Z'
    : 'M46 296 C 83 329 136 340 181 317 C 191 336 184 360 165 371 C 114 391 51 372 24 329 C 28 313 35 303 46 296 Z';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${defs()}
      <g filter="url(#softShadow)">
        <path class="outline" fill="url(#robeGrad)" filter="url(#paintNoise)" d="${bodyPath}"/>
        <clipPath id="sleeveClip"><path d="${bodyPath}"/></clipPath>
        <g clip-path="url(#sleeveClip)">
          ${robeStars(wide ? 41 : 57, width, height, wide ? 48 : 38)}
          <path class="trimFine" opacity="0.55" d="${wide ? 'M68 89 C 125 125 190 125 241 104 M52 181 C 112 225 192 232 247 202 M42 285 C 101 332 179 338 226 310' : 'M62 78 C 110 109 169 111 213 91 M47 162 C 99 202 171 205 220 177 M38 246 C 87 286 151 291 191 268'}"/>
        </g>
        <path class="trim" d="${wide ? 'M85 39 C 127 68 188 76 237 104 M34 367 C 78 420 144 437 200 414' : 'M81 29 C 116 55 170 65 211 88 M26 310 C 67 352 122 363 173 339'}"/>
        <path class="outline" fill="#130f22" d="${cuffPath}"/>
        <path class="trim" d="${wide ? 'M36 394 C 78 440 147 455 196 426' : 'M35 322 C 73 358 126 367 169 343'}"/>
        <path class="trimFine" d="${wide ? 'M63 386 C 101 412 154 421 194 401' : 'M55 314 C 90 335 130 341 173 322'}"/>
      </g>
    </svg>`;
}

function handSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="279" height="272" viewBox="0 0 279 272">
      ${defs()}
      <g filter="url(#softShadow)">
        <path class="outline" fill="url(#robeGrad)" filter="url(#paintNoise)" d="M16 135 C 26 84 75 52 127 63 C 157 99 160 149 133 199 C 77 207 32 184 16 135 Z"/>
        <path class="trim" d="M31 97 C 61 135 99 153 145 153"/>
        <path class="outline" fill="#130f22" d="M91 66 C 125 84 147 118 148 153 C 126 179 81 177 45 151 C 36 118 51 83 91 66 Z"/>
        <path class="trimFine" d="M49 124 C 76 149 112 162 145 153"/>

        <path class="outline" fill="url(#furGrad)" d="M103 82 C 150 45 209 49 245 88 C 278 125 263 179 214 205 C 157 235 89 206 70 151 C 61 123 72 101 103 82 Z"/>
        <path fill="url(#furDarkGrad)" opacity="0.34" d="M94 152 C 135 169 197 168 245 126 C 246 169 213 204 165 211 C 127 216 95 199 79 169 Z"/>
        <path class="outline" fill="url(#furGrad)" d="M145 68 C 157 32 184 16 209 25 C 211 62 192 90 159 104 Z"/>
        <path class="outline" fill="url(#furGrad)" d="M185 78 C 204 43 235 33 257 48 C 250 84 224 107 190 111 Z"/>
        <path fill="${pink}" opacity="0.45" d="M160 73 C 169 47 185 33 200 31 C 197 59 185 80 164 94 Z"/>
        <path fill="${pink}" opacity="0.42" d="M201 82 C 216 58 236 48 249 52 C 239 75 220 92 199 100 Z"/>
        <path class="fine" d="M124 111 C 148 101 174 105 195 121 M106 151 C 141 172 190 170 225 145 M97 185 C 122 205 171 210 210 189"/>
        <path class="fine" d="M214 94 C 235 88 257 90 273 101 M218 107 C 241 106 259 111 274 124"/>
        <path class="fine" d="M92 119 C 77 126 63 140 55 157"/>
        <path class="outline" fill="${ink}" d="M232 121 C 247 121 256 129 254 140 C 240 141 230 134 232 121 Z"/>
        <path fill="url(#eyeGrad)" d="M180 102 C 190 96 202 98 208 108 C 198 114 186 113 180 102 Z"/>
        <circle cx="195" cy="103" r="2.8" fill="#fff7ca"/>
      </g>
    </svg>`;
}

const assets = [
  { name: 'body', width: 760, height: 1010, svg: bodySvg() },
  { name: 'upper-arm', width: 297, height: 472, svg: sleeveSvg(297, 472, 'upper') },
  { name: 'forearm', width: 242, height: 379, svg: sleeveSvg(242, 379, 'forearm') },
  { name: 'hand-cupped', width: 279, height: 272, svg: handSvg() },
];

await mkdir(outDir, { recursive: true });
await mkdir(tmpDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const asset of assets) {
    const page = await browser.newPage({
      viewport: { width: asset.width, height: asset.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden;}svg{display:block;}</style></head><body>${asset.svg}</body></html>`);
    const pngPath = new URL(`${asset.name}.png`, tmpDir);
    const webpPath = new URL(`${asset.name}.webp`, outDir);
    await page.screenshot({
      path: pngPath.pathname,
      omitBackground: true,
      clip: { x: 0, y: 0, width: asset.width, height: asset.height },
    });
    await page.close();
    await execFileAsync('/opt/homebrew/bin/cwebp', ['-quiet', '-q', '92', '-alpha_q', '100', pngPath.pathname, '-o', webpPath.pathname]);
  }
} finally {
  await browser.close();
}

await rm(tmpDir, { recursive: true, force: true });
