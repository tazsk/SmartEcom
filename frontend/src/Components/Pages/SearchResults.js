// src/Pages/SearchResults.js
import React, { useContext, useState } from 'react';
import { ShopContext } from '../Context/ShopContext';
import './css/SearchResults.css';

const SectionTitle = ({ children }) => (
  <div className="section-title">
    <span>{children}</span>
  </div>
);

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
  } = useContext(ShopContext);

  const [query, setQuery] = useState('');
  const [zip, setZip] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [pendingUpc, setPendingUpc] = useState(null);

  const onSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setHasSearched(true);
    await fetchMatchedProductsPhased(query.trim(), zip.trim() || undefined);
  };

  const phaseText =
    searchPhase === 'finding'  ? 'Finding ingredients...' :
    searchPhase === 'fetching' ? 'Fetching products...' :
    searchPhase === 'matching' ? 'Matching products...' :
    'Working...';

  const inc = async (upc) => {
    try { setPendingUpc(upc); await addToKrogerCart(upc, 1); }
    finally { setPendingUpc(null); }
  };

  const dec = async (upc) => {
    if (getInCartQty(upc) <= 0) return;
    try { setPendingUpc(upc); await addToKrogerCart(upc, -1); }
    finally { setPendingUpc(null); }
  };

  return (
    <div className="search-results" aria-busy={loadingSearch}>
      <form className="search-bar" onSubmit={onSearch}>
        <input
          type="text"
          placeholder="Search dish or ingredient..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loadingSearch}
          aria-label="Search"
        />
        <input
          type="text"
          placeholder="ZIP (optional)"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          disabled={loadingSearch}
          aria-label="ZIP"
        />
        <button type="submit" disabled={loadingSearch}>Search</button>
      </form>

      {error && <div className="error">{error}</div>}

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
              <SectionTitle>Kroger products</SectionTitle>
              <div className="products">
                {krogerResults.map((p) => {
                  const qty = getInCartQty(p.upc);
                  const busy = pendingUpc === p.upc;

                  return (
                    <div className="product-card" key={p._id}>
                      <img src={p.imageUrl} alt={p.title} />
                      <h3>{p.title}</h3>

                      <div className="card-footer">
                        <span className="product-price">
                          ${(p.price ?? 0).toFixed(2)}
                        </span>

                        {qty > 0 ? (
                          <div className="qty-controls" aria-label="Quantity controls">
                            <button
                              type="button"
                              className="qty-btn"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); dec(p.upc); }}
                              disabled={busy || qty <= 0}
                              aria-label="Decrease quantity"
                            >
                              −
                            </button>

                            <span className="qty-count" aria-live="polite" aria-atomic="true">
                              {qty}
                            </span>

                            <button
                              type="button"
                              className="qty-btn"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); inc(p.upc); }}
                              disabled={busy}
                              aria-label="Increase quantity"
                            >
                              +
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="add-cta"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); inc(p.upc); }}
                            disabled={busy}
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
              <SectionTitle>
                Walmart products {unmatchedTerms.length > 0 && (
                  <em className="muted"> (for unmatched: {unmatchedTerms.join(', ')})</em>
                )}
              </SectionTitle>

              <div className="products">
                {walmartResults.map((p) => (
                  <a
                    className="product-card product-card--link"
                    key={p._id}
                    href={p.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                    title="Opens Walmart product page"
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
