import requests
import re
import logging

class WebSearcher:
    def __init__(self):
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }

    def search(self, query):
        if not query:
            return "Please provide a query to search."
        try:
            url = f"https://html.duckduckgo.com/html/?q={requests.utils.quote(query)}"
            logging.info(f"Performing web search for: {query}")
            response = requests.get(url, headers=self.headers, timeout=10)
            if response.status_code != 200:
                return f"Failed to retrieve search results (HTTP {response.status_code})."
            
            # DuckDuckGo HTML structure has snippets inside <a class="result__snippet" ...>...</a>
            snippets = re.findall(r'<a class="result__snippet"[^>]*>(.*?)</a>', response.text, re.DOTALL)
            
            if not snippets:
                # Alternative fallback patterns
                snippets = re.findall(r'<td class="result-snippet">(.*?)</td>', response.text, re.DOTALL)
                
            results = []
            for i, snip in enumerate(snippets[:3]):
                # Clean HTML tags
                clean_snip = re.sub(r'<[^>]+>', '', snip).strip()
                # Unescape HTML characters
                clean_snip = (clean_snip.replace("&amp;", "&")
                                        .replace("&quot;", '"')
                                        .replace("&lt;", "<")
                                        .replace("&gt;", ">")
                                        .replace("&#x27;", "'")
                                        .replace("&nbsp;", " "))
                results.append(f"{i+1}. {clean_snip}")
                
            if not results:
                return "I searched the web but couldn't find any relevant results."
                
            return "Web search results:\n" + "\n".join(results)
        except Exception as e:
            logging.error(f"Web search failed: {e}")
            return f"An error occurred while searching the web: {e}"
