import numpy as np
from scipy.optimize import minimize_scalar

def softmax(z):
    z = z - z.max(1, keepdims=True); e = np.exp(z); return e / e.sum(1, keepdims=True)

def fit_temperature(logits, y):
    nll = lambda T: -np.log(softmax(logits / T)[np.arange(len(y)), y] + 1e-12).mean()
    return float(minimize_scalar(nll, bounds=(0.2, 10), method="bounded").x)

def apply_other_bias(logits, other_id, b):
    z = logits.copy(); z[:, other_id] += b; return z
