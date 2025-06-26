import re
from flask import Flask, request, jsonify
from flask_cors import CORS
from llama_index.core import VectorStoreIndex, Document, StorageContext, load_index_from_storage
from pymongo import MongoClient
from dotenv import load_dotenv
import os
from fuzzywuzzy import fuzz
from fuzzywuzzy import process
from nltk.stem import PorterStemmer

load_dotenv()

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Persistent index directory
PERSIST_DIR = "./saved_index"

# MongoDB connection
mongo_url = os.getenv("MONGO_URL")
mongo_client = MongoClient(mongo_url)
db = mongo_client.ecommerce
products_collection = db.products

def build_and_save_index():
    """Build and save the LlamaIndex from MongoDB documents."""
    if not os.path.exists(PERSIST_DIR):
        os.makedirs(PERSIST_DIR)  # Create the directory if it doesn't exist
        print(f"Created directory for index persistence: {PERSIST_DIR}")

    products = products_collection.find()

    documents = [
        Document(
            text=f"{product['title']} {product.get('description', '')} {product.get('category', '')}".strip(),
            metadata={
                "id": str(product['_id']),
                "title": product['title'],
                "description": product.get('description', ''),
                "price": product.get('price', 0),
                "category": product.get('category', ''),
                "imageUrl": product.get('imageUrl', '')
            }
        )
        for product in products
    ]
    index = VectorStoreIndex.from_documents(documents)
    index.storage_context.persist(persist_dir=PERSIST_DIR)
    print("Index has been successfully built and saved.")
    return index


def load_or_build_index():
    """Load the index from storage or build it if not available."""
    if os.path.exists(PERSIST_DIR) and os.listdir(PERSIST_DIR):
        print("Loading existing index...")
        storage_context = StorageContext.from_defaults(persist_dir=PERSIST_DIR)
        index = load_index_from_storage(storage_context)
    else:
        print("Index not found. Building a new index...")
        index = build_and_save_index()
    return index


# Load or build the index
index = load_or_build_index()
query_engine = index.as_query_engine()

stemmer = PorterStemmer()

def preprocess_ingredient(ingredient):
    """Remove stopwords and stem tokens."""
    stopwords = {"green", "fresh", "for", "with", "on", "in", "and"}
    tokens = re.split(r'\W+', ingredient.lower())
    return [stemmer.stem(token) for token in tokens if token not in stopwords]

@app.route('/query', methods=['POST'])
def query_index():
    """Handle POST requests to query the index."""
    try:
        data = request.json
        print(f"Received Request: {data}")

        query_ingredients = data.get('query', [])
        print(f"Query Ingredients: {query_ingredients}")

        # Tokenize and preprocess the query ingredients
        processed_ingredients = []
        for ingredient in query_ingredients:
            processed_ingredients.extend(preprocess_ingredient(ingredient))
        print(f"Processed Ingredients: {processed_ingredients}")

        # Fetch products from MongoDB
        products = products_collection.find()
        indexed_titles = [
            {
                "title": product["title"],
                "metadata": {
                    "id": str(product["_id"]),
                    "description": product.get("description", ""),
                    "price": product.get("price", 0),
                    "category": product.get("category", ""),
                    "imageUrl": product.get("imageUrl", "")
                }
            }
            for product in products
        ]

        # Match query ingredients with indexed titles
        matched_titles = []
        results = []
        for product in indexed_titles:
            title_tokens = preprocess_ingredient(product["title"])
            intersection = set(processed_ingredients).intersection(set(title_tokens))
            if len(intersection) > 0:  # At least one token should match
                matched_titles.append(product["title"])
                results.append({
                    "text": product["title"],
                    "metadata": product["metadata"]
                })

        matched_titles = list(set(matched_titles))  # Remove duplicates

        return jsonify({
            "results": results,
            "matched_titles": matched_titles
        })

    except Exception as e:
        print(f"Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/')
def home():
    """Root endpoint to confirm the server is running."""
    return "LlamaIndex Server is Running", 200


if __name__ == '__main__':
    app.run(port=5000)
