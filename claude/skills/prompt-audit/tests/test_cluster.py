import sys, unittest
from unittest import mock
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import cluster

class TestCluster(unittest.TestCase):
    def test_greedy_cluster(self):
        vecs = [[1.0, 0.0], [0.99, 0.01], [0.0, 1.0]]
        cs = cluster.greedy_cluster(vecs, threshold=0.9)
        sizes = sorted(c["size"] for c in cs)
        self.assertEqual(sizes, [1, 2])

    def test_token_signature_cluster(self):
        cs = cluster.token_signature_cluster(["commit the changes", "commit the changes now", "run the tests"])
        self.assertEqual(sorted(c["size"] for c in cs), [1, 2])

    def test_embed_parses_response(self):
        fake = mock.MagicMock()
        fake.read.return_value = b'{"embedding": [0.1, 0.2]}'
        fake.__enter__.return_value = fake
        with mock.patch("urllib.request.urlopen", return_value=fake):
            self.assertEqual(cluster.embed(["hi"]), [[0.1, 0.2]])

    def test_cluster_falls_back_when_no_ollama(self):
        with mock.patch.object(cluster, "ollama_available", return_value=False):
            cs, method = cluster.cluster(["a b c", "a b c"], use_embeddings=True)
            self.assertEqual(method, "token-signature")
            self.assertEqual(cs[0]["size"], 2)

if __name__ == "__main__":
    unittest.main()
