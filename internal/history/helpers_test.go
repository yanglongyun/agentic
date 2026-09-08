package history

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func readLines[T any](path string) ([]T, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []T
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scan.Scan() {
		var v T
		if err = json.Unmarshal(scan.Bytes(), &v); err != nil {
			return nil, fmt.Errorf("%s 第 %d 行: %w", path, len(out)+1, err)
		}
		out = append(out, v)
	}
	return out, scan.Err()
}
