import React, { useContext, useState, useEffect } from 'react';
import { ShopContext } from '../Context/ShopContext';
import './css/SearchResults.css'

const SearchResults = () => {
  const { fetchMatchedProducts, searchResults, addToCart, products } = useContext(ShopContext);
  const [query, setQuery] = useState('');
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchAndMatchProducts = async () => {
    setLoading(true);
    try {
      const matched = products.filter(product =>
        searchResults.includes(product.title)
      );
      console.log('Matched products:', matched);
      setMatchedProducts(matched);
    } catch (error) {
      console.error('Error fetching and matching products:', error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (searchResults.length > 0) {
      fetchAndMatchProducts();
    }// eslint-disable-next-line
  }, [searchResults]);

  const handleSearch = () => {
    fetchMatchedProducts(query);
  };

  if (loading) {
    return <div>Loading search results...</div>;
  }

  console.log('Search Results: ', searchResults);

  return (
    <div className="search-results">
      <div className="search-bar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a dish..."
        />
        <button onClick={handleSearch}>Search</button>
      </div>
      {(!matchedProducts || matchedProducts.length === 0) ? (
        <p>No products found for the search query.</p>
      ) : (
        <div className="products">
          {matchedProducts.map((product) => (
            <div key={product._id} className="product-card">
              <img src={product.imageUrl} alt={product.title} />
              <h3>{product.title}</h3>
              <p className="product-price">Price: ${product.price.toFixed(2)}</p>
              <button onClick={() => addToCart(product._id)}>Add to Cart</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SearchResults;
