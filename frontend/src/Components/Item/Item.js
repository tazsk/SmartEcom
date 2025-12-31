import React from 'react'
import './Item.css'
import { Link } from 'react-router-dom'
import { ShopContext } from '../Context/ShopContext';
import { useContext } from 'react';

const Item = (props) => {

  const { addToCart } = useContext(ShopContext);

  return (
    <div className="item">
        <Link to={`/product/${props.id}`}><img onClick={window.scrollTo({ top: 0, behavior: 'smooth' })} src={props.image} alt="" /></Link>
        <p>{props.name}</p>
        <div className="item-prices">
            {props.price}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation(); // avoid triggering the Link if the card is clickable
            addToCart(props.id);
          }}
          >
          Add to Cart
        </button>
    </div>
  )
}

export default Item