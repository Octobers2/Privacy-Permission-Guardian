import numpy as np

def confusion(y, p, k):
    m = np.zeros((k, k), int)
    for a, b in zip(y, p): m[a, b] += 1
    return m

def prf(m):
    tp = np.diag(m).astype(float); fp = m.sum(0) - tp; fn = m.sum(1) - tp
    pr = np.divide(tp, tp + fp, out=np.zeros_like(tp), where=(tp + fp) > 0)
    rc = np.divide(tp, tp + fn, out=np.zeros_like(tp), where=(tp + fn) > 0)
    f1 = np.divide(2 * pr * rc, pr + rc, out=np.zeros_like(tp), where=(pr + rc) > 0)
    return pr, rc, f1

def ece(probs, y, bins=15):
    conf = probs.max(1); ok = (probs.argmax(1) == y); e = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        s = (conf > lo) & (conf <= hi)
        if s.any(): e += s.mean() * abs(ok[s].mean() - conf[s].mean())
    return float(e)

def brier(probs, y):
    oh = np.eye(probs.shape[1])[y]
    return float(((probs - oh) ** 2).sum(1).mean())

def summarize(probs, y, other_id, boots=1000, seed=0):
    """probs: (n,k) rows sum to 1. Returns a dict with bootstrap 95% CIs on the headline numbers."""
    probs = np.asarray(probs); y = np.asarray(y); k = probs.shape[1]
    def point(idx):
        pp, yy = probs[idx], y[idx]; pred = pp.argmax(1)
        pr, rc, f1 = prf(confusion(yy, pred, k))
        present = np.bincount(yy, minlength=k) > 0
        bt, bp = yy != other_id, pred != other_id          # unfair vs fair
        tp = (bt & bp).sum(); fp = (~bt & bp).sum(); fn = (bt & ~bp).sum()
        bf1 = 2 * tp / max(2 * tp + fp + fn, 1)
        return dict(macro_f1=float(f1[present].mean()), acc=float((pred == yy).mean()), unfair_f1=float(bf1),
                    ece=ece(pp, yy), brier=brier(pp, yy)), (pr, rc, f1)
    base, (pr, rc, f1) = point(np.arange(len(y)))
    rng = np.random.default_rng(seed); samples = {k_: [] for k_ in base}
    for _ in range(boots):
        r, _x = point(rng.integers(0, len(y), len(y)))
        for k_, v in r.items(): samples[k_].append(v)
    ci = {k_: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] for k_, v in samples.items()}
    return dict(n=len(y), **base, ci95=ci,
                per_class=[dict(id=i, precision=float(pr[i]), recall=float(rc[i]), f1=float(f1[i]), support=int((y == i).sum())) for i in range(k)])
