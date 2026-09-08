package main

import (
	"fmt"
	"os"

	"github.com/yanglongyun/agentic/internal/cli"
)

var version = "dev"

func main() {
	if err := cli.Run(os.Args[1:], version); err != nil {
		fmt.Fprintln(os.Stderr, "错误："+err.Error())
		os.Exit(1)
	}
}
