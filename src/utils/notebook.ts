/**
 * Shared notebook utility — checks whether a file path targets a Jupyter notebook.
 * Case-insensitive to handle `.IPYNB`, `.Ipynb`, etc.
 */
export function isNotebookFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ipynb');
}
