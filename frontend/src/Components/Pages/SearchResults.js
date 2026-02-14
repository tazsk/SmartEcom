// src/Pages/SearchResults.js
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ShopContext } from '../Context/ShopContext';
import './css/SearchResults.css';

const SearchResults = () => {
  const {
    fetchMatchedProductsPhased,
    krogerResults,
    walmartResults,
    unmatchedTerms,
    loadingSearch,
    searchPhase,
    error,
    addToKrogerCart,
    getInCartQty,

    agenticActiveUpc,
    agenticCartProgress,
    agenticMessage,

    // ✅ NEW
    uploadFridgePhoto,
    fridgeSessionId,
    fridgeItems,
    setFridgeSessionId,
    setFridgeItems,
  } = useContext(ShopContext);

  const [query, setQuery] = useState('');
  const [zip, setZip] = useState('');
  const [budgetSearch, setBudgetSearch] = useState(false);
  const [autoAddToCart, setAutoAddToCart] = useState(true);

  const [hasSearched, setHasSearched] = useState(false);
  const [pendingUpc, setPendingUpc] = useState(null);

  // ✅ NEW: local upload UI
  const [fridgeUploading, setFridgeUploading] = useState(false);
  const [fridgePreviewUrl, setFridgePreviewUrl] = useState(null);

  // Fake cursor state (optional but keeps the “agentic feel”)
  const cursorRef = useRef(null);
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorXY, setCursorXY] = useState({ x: -9999, y: -9999 });

  const phaseText =
    searchPhase === 'finding' ? 'Finding ingredients...' :
    searchPhase === 'fetching' ? 'Fetching products...' :
    searchPhase === 'matching' ? 'Matching products...' :
    searchPhase === 'walmart' ? 'Searching Walmart...' :
    searchPhase === 'selecting' ? 'Comparing prices...' :
    'Working...';

  const krogerUpcsSet = useMemo(
    () => new Set(krogerResults.map(p => String(p.upc || '').trim()).filter(Boolean)),
    [krogerResults]
  );

  const onSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setHasSearched(true);

    const q = query.trim();
    const z = zip.trim() || undefined;

    await fetchMatchedProductsPhased(q, z, budgetSearch, autoAddToCart, fridgeSessionId);
  };

  const onPickFridgePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFridgeUploading(true);
    setFridgePreviewUrl(URL.createObjectURL(file));

    const result = await uploadFridgePhoto(file);
    if (!result) {
      setFridgePreviewUrl(null);
    }

    setFridgeUploading(false);
  };

  const clearFridge = () => {
    setFridgeSessionId(null);
    setFridgeItems([]);
    setFridgePreviewUrl(null);
  };

  const inc = async (upc) => {
    try {
      setPendingUpc(upc);
      await addToKrogerCart(upc, 1);
    } finally {
      setPendingUpc(null);
    }
  };

  const dec = async (upc) => {
    if (getInCartQty(upc) <= 0) return;
    try {
      setPendingUpc(upc);
      await addToKrogerCart(upc, -1);
    } finally {
      setPendingUpc(null);
    }
  };

  // Auto-scroll to active UPC
  useEffect(() => {
    if (!agenticActiveUpc) return;
    const el = document.getElementById(`kroger-${agenticActiveUpc}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [agenticActiveUpc]);

  // Fake cursor moves to + button (visual only)
  useEffect(() => {
    const upc = String(agenticActiveUpc || '').trim();
    if (!autoAddToCart) return;
    if (!upc) return;
    if (!krogerUpcsSet.has(upc)) return;

    const plusBtn = document.getElementById(`plus-${upc}`);
    if (!plusBtn) return;

    setCursorVisible(true);

    const rect = plusBtn.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;

    setCursorXY({ x: targetX - 8, y: targetY - 10 });

    plusBtn.classList.remove('agentic-pulse');
    // eslint-disable-next-line no-unused-expressions
    plusBtn.offsetHeight;
    plusBtn.classList.add('agentic-pulse');

    if (cursorRef.current) {
      cursorRef.current.classList.remove('agentic-tap');
      // eslint-disable-next-line no-unused-expressions
      cursorRef.current.offsetHeight;
      cursorRef.current.classList.add('agentic-tap');
    }
  }, [agenticActiveUpc, autoAddToCart, krogerUpcsSet]);

  useEffect(() => {
    if (!autoAddToCart) {
      setCursorVisible(false);
      return;
    }
    if (agenticCartProgress.active) return;
    if (agenticCartProgress.total > 0) {
      const t = setTimeout(() => setCursorVisible(false), 900);
      return () => clearTimeout(t);
    }
  }, [agenticCartProgress.active, agenticCartProgress.total, autoAddToCart]);

  return (
    <div className="search-results" aria-busy={loadingSearch}>
      {/* Fake cursor overlay */}
      <div
        ref={cursorRef}
        className={`agentic-cursor ${cursorVisible ? 'agentic-cursor--show' : ''}`}
        style={{ transform: `translate3d(${cursorXY.x}px, ${cursorXY.y}px, 0)` }}
        aria-hidden="true"
      />

      <form className="search-bar" onSubmit={onSearch}>
        <input
          type="text"
          placeholder="Search dish or ingredient..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loadingSearch}
        />

        <input
          type="text"
          placeholder="ZIP (optional)"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          disabled={loadingSearch}
        />

        <label className="budget-toggle">
          <input
            type="checkbox"
            checked={budgetSearch}
            onChange={(e) => setBudgetSearch(e.target.checked)}
            disabled={loadingSearch}
          />
          <span>Budget Search</span>
        </label>

        <label className="agent-toggle" title="Backend will auto-add matched Kroger items to your Kroger cart">
          <input
            type="checkbox"
            checked={autoAddToCart}
            onChange={(e) => setAutoAddToCart(e.target.checked)}
            disabled={loadingSearch}
          />
          <span>Auto-add to Kroger cart</span>
        </label>

        <button type="submit" disabled={loadingSearch}>
          {autoAddToCart ? 'Agentic Search + Add' : 'Search'}
        </button>
      </form>

      {/* ✅ NEW: Fridge photo upload panel */}
      <div className="fridge-panel">
        <div className="fridge-header">
          <div className="fridge-title">Fridge / Pantry photo (optional)</div>
          {fridgeSessionId && (
            <button type="button" className="fridge-clear" onClick={clearFridge}>
              Clear
            </button>
          )}
        </div>

        <div className="fridge-row">
          <label className="fridge-upload">
            <input
              type="file"
              accept="image/*"
              onChange={onPickFridgePhoto}
              disabled={fridgeUploading || loadingSearch}
            />
            {fridgeUploading ? 'Analyzing photo…' : (fridgeSessionId ? 'Replace photo' : 'Upload photo')}
          </label>

          {fridgePreviewUrl && (
            <img className="fridge-preview" src={fridgePreviewUrl} alt="Fridge preview" />
          )}
        </div>

        {fridgeItems.length > 0 && (
          <div className="fridge-items">
            <div className="fridge-items-label">Detected items:</div>
            <div className="fridge-chips">
              {fridgeItems.map((it, idx) => (
                <span className="chip" key={`${it}-${idx}`}>{it}</span>
              ))}
            </div>
            <div className="fridge-hint">
              Auto-add will skip products that match these items.
            </div>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {autoAddToCart && agenticCartProgress.total > 0 && (
        <div className="agentic-progress" aria-live="polite">
          Adding to cart: {agenticCartProgress.addedCount}/{agenticCartProgress.total}
          {agenticCartProgress.skippedCount > 0 ? ` (skipped ${agenticCartProgress.skippedCount})` : ''}
        </div>
      )}

      {autoAddToCart && agenticMessage && (
        <div className="agentic-done" aria-live="polite">
          {agenticMessage}
        </div>
      )}

      {loadingSearch ? (
        <div className="loader-wrap" role="status" aria-live="polite">
          <div className="loader" />
          <div className="loader-text">{phaseText}</div>
        </div>
      ) : (
        <>
          {hasSearched && krogerResults.length === 0 && walmartResults.length === 0 && (
            <div className="empty-hint">No matching products found.</div>
          )}

          {krogerResults.length > 0 && (
            <>
              <div className="section-title">Kroger products</div>
              <div className="products">
                {krogerResults.map((p) => {
                  const qty = getInCartQty(p.upc);
                  const busy = pendingUpc === p.upc;
                  const isActive = agenticActiveUpc === p.upc;

                  return (
                    <div
                      className={`product-card ${isActive ? 'product-card--active' : ''}`}
                      id={`kroger-${p.upc}`}
                      key={p._id}
                    >
                      <img src={p.imageUrl} alt={p.title} />
                      <h3>{p.title}</h3>

                      <div className="card-footer">
                        <span className="product-price">${(p.price ?? 0).toFixed(2)}</span>

                        {qty > 0 ? (
                          <div className="qty-controls">
                            <button
                              type="button"
                              className="qty-btn"
                              onClick={() => dec(p.upc)}
                              disabled={busy || qty <= 0}
                              id={`minus-${p.upc}`}
                            >
                              −
                            </button>
                            <span className="qty-count">{qty}</span>
                            <button
                              type="button"
                              className="qty-btn"
                              onClick={() => inc(p.upc)}
                              disabled={busy}
                              id={`plus-${p.upc}`}
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="add-cta"
                            onClick={() => inc(p.upc)}
                            disabled={busy}
                            id={`plus-${p.upc}`}
                          >
                            Add to Kroger Cart
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {walmartResults.length > 0 && (
            <>
              <div className="section-title">
                Walmart products{' '}
                {unmatchedTerms.length > 0 && (
                  <em className="muted"> (for: {unmatchedTerms.join(', ')})</em>
                )}
              </div>
              <div className="products">
                {walmartResults.map((p) => (
                  <a
                    className="product-card product-card--link"
                    key={p._id}
                    href={p.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img src={p.imageUrl} alt={p.title} />
                    <h3>{p.title}</h3>
                    <div className="card-footer">
                      <span className="product-price">${(p.price ?? 0).toFixed(2)}</span>
                      <span className="retailer-badge">View at Walmart ↗</span>
                    </div>
                  </a>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default SearchResults;
