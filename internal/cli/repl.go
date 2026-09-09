package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/cli/render"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/server"
	"github.com/yanglongyun/agentic/internal/storage"
)

type operationResult struct {
	text       string
	err        error
	elapsed    time.Duration
	background bool
}

func runOperation(ctx context.Context, a *agent.Agent, text string) operationResult {
	started := time.Now()
	result := operationResult{}
	checkpoint, err := a.History.Checkpoint()
	if err != nil {
		result.err = err
		return result
	}
	result.text, result.err = a.Turn(ctx, text)
	if ctx.Err() != nil {
		result.err = ctx.Err()
	}
	if result.err != nil {
		if err = a.History.Restore(checkpoint); err != nil {
			result.err = fmt.Errorf("%w；恢复上下文失败：%v", result.err, err)
		}
	}
	result.elapsed = time.Since(started)
	return result
}
func selectSession(a *agent.Agent, root, id string) error {
	dir, err := storage.SessionDir(root, id)
	if err != nil {
		return err
	}
	// Selection must never manufacture a missing or incomplete session.
	for _, name := range []string{"session.json", "messages.jsonl", "compactions.jsonl"} {
		if _, err = os.Stat(filepath.Join(dir, name)); err != nil {
			return err
		}
	}
	h, err := history.Open(dir)
	if err != nil {
		return err
	}
	if _, err = h.Items(); err != nil {
		return err
	}
	if err = storage.WriteJSON(filepath.Join(root, "state.json"), storage.State{CurrentSession: id}); err != nil {
		return err
	}
	a.History = h
	return nil
}

func repl(a *agent.Agent, root, version string, browse bool) error {
	keys, closeKeyboard, err := startKeyboard()
	if err != nil {
		return fmt.Errorf("无法读取交互终端：%w", err)
	}
	defer closeKeyboard()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	api, err := server.Start(a.Config, root)
	if err != nil {
		return err
	}
	agents := api.Agents()
	a.Spawn = func(ctx context.Context, prompt string) (string, error) { return agents.Spawn(ctx, a.History, prompt) }
	currentID := func() string {
		if a.History == nil {
			return ""
		}
		return filepath.Base(a.History.Dir)
	}
	releaseSession := func() {}
	defer func() { api.Close(); releaseSession() }()
	switchSession := func(id string) error {
		if id == currentID() {
			return nil
		}
		release, err := api.ReserveSession(id)
		if err != nil {
			return err
		}
		if err := selectSession(a, root, id); err != nil {
			release()
			return err
		}
		releaseSession()
		releaseSession = release
		return nil
	}
	fmt.Fprint(os.Stdout, render.Banner(version, a.Config.Model, api.URL))
	var entries []history.Session
	page := 0
	selecting := false
	var line []rune
	var results chan operationResult
	var cancel context.CancelFunc
	var draft []rune
	checkAgents := true
	showList := func() {
		if len(entries) == 0 {
			fmt.Println(render.Gray("暂无历史会话"))
			return
		}
		start := page * 15
		end := start + 15
		if end > len(entries) {
			end = len(entries)
		}
		fmt.Print(render.ResumeHeader(page+1, (len(entries)+14)/15))
		for i := start; i < end; i++ {
			fmt.Print(render.ResumeRow(i+1, entries[i].Preview, entries[i].Updated.Local().Format("01-02 15:04"), entries[i].ID, entries[i].ID == currentID()))
		}
		fmt.Print(render.ResumeNavigation(page+1, (len(entries)+14)/15))
	}
	openList := func() {
		var e error
		entries, e = history.List(root)
		if e != nil {
			printErr(e)
			return
		}
		page = 0
		selecting = len(entries) > 0
		showList()
	}
	prompt := func() {
		if selecting {
			fmt.Print(render.Cyan("编号") + render.Prompt(" › "))
		} else {
			fmt.Print(render.Prompt("› "))
		}
	}
	if browse {
		openList()
	}
	prompt()
	defer func() {
		if cancel != nil {
			cancel()
			<-results
		}
	}()
	for {
		changed := agents.Changes()
		if checkAgents && cancel == nil && !selecting && a.History != nil {
			checkAgents = false
			records, err := agents.Pending(a.History)
			if err != nil {
				printErr(err)
			} else if len(records) > 0 {
				draft = append([]rune(nil), line...)
				fmt.Print(render.ClearInput("› "+string(line), terminalColumns()))
				fmt.Print(render.Cyan("agent") + " " + render.Gray(fmt.Sprintf("%d 个任务返回", len(records))) + "\n")
				ctx, stop := context.WithCancel(context.Background())
				cancel = stop
				results = make(chan operationResult, 1)
				go func(output chan<- operationResult) {
					started := time.Now()
					text, err := agents.Deliver(ctx, a, records)
					output <- operationResult{text: text, err: err, elapsed: time.Since(started), background: true}
				}(results)
			}
		}
		select {
		case <-changed:
			checkAgents = true
		case <-api.Done():
			return fmt.Errorf("API 服务已停止：%v", api.Err())
		case sig := <-signals:
			if cancel != nil {
				cancel()
				if sig == os.Interrupt {
					continue
				}
				<-results
				cancel = nil
			}
			return nil
		case result := <-results:
			cancel()
			cancel = nil
			results = nil
			if errors.Is(result.err, context.Canceled) {
				fmt.Println("\n已中断")
			} else {
				if result.text != "" {
					fmt.Print("\n" + render.Markdown(result.text))
				}
				if result.err != nil {
					printErr(result.err)

				} else {
					fmt.Print(render.Footer(result.elapsed, a.History.Tokens(), a.Config.CompactAt))
				}
			}
			if result.background {
				line = draft
				draft = nil
				checkAgents = result.err == nil
			} else {
				line = nil
				checkAgents = true
			}
			prompt()
			fmt.Print(string(line))
		case k, ok := <-keys:
			if !ok {
				return nil
			}
			if k.err != nil {
				return k.err
			}
			if cancel != nil {
				if k.r == 27 || k.r == 3 {
					cancel()
				}
				continue
			}
			switch k.r {
			case 3, 4:
				fmt.Println()
				return nil
			case 27:
				line = nil
				selecting = false
				fmt.Print("\r\033[2K")
				prompt()
				continue
			case 8, 127:
				if len(line) > 0 {
					line = line[:len(line)-1]
					fmt.Print("\r\033[2K")
					prompt()
					fmt.Print(string(line))
				}
				continue
			case 21:
				line = nil
				fmt.Print("\r\033[2K")
				prompt()
				continue
			case '\r', '\n':
				text := strings.TrimSpace(string(line))
				if render.Enabled() && !selecting && text != "" && !localCommand(text) {
					fmt.Print(render.ClearInput("› "+string(line), terminalColumns()))
					fmt.Print(render.UserMessage(text))
				} else {
					fmt.Println()
				}
				line = nil
				if selecting {
					switch text {
					case "", "q":
						selecting = false
					case "n":
						if (page+1)*15 < len(entries) {
							page++
						}
						showList()
					case "p":
						if page > 0 {
							page--
						}
						showList()
					default:
						n, e := strconv.Atoi(text)
						if e != nil || n < 1 || n > len(entries) {
							printErr(errors.New("请输入有效的会话编号"))
						} else if e = switchSession(entries[n-1].ID); e != nil {
							printErr(e)
						} else {
							selecting = false
							checkAgents = true
							fmt.Println("已切换到会话", entries[n-1].ID)
							if e := printHistory(a.History, a.Config.ResumeMessages); e != nil {
								printErr(e)
							}
						}
					}
					prompt()
					continue
				}
				checkAgents = true
				switch text {
				case "":
					prompt()
					continue
				case "/exit", "/quit":
					return nil
				case "/help":
					fmt.Print(render.Help())
					prompt()
					continue
				case "/status":
					printStatus(a)
					prompt()
					continue
				case "/resume":
					openList()
					prompt()
					continue
				case "/reset", "/compact", "/messages":
					printErr(fmt.Errorf("未知命令 %s", text))
					prompt()
					continue
				}
				if e := a.Config.Validate(); e != nil {
					printErr(e)
					prompt()
					continue
				}
				if a.History == nil {
					h, err := newSession(root)
					if err != nil {
						printErr(err)
						prompt()
						continue
					}
					release, err := api.ReserveSession(filepath.Base(h.Dir))
					if err != nil {
						printErr(err)
						prompt()
						continue
					}
					a.History = h
					releaseSession = release
				}
				ctx, stop := context.WithCancel(context.Background())
				cancel = stop
				results = make(chan operationResult, 1)
				go func(output chan<- operationResult) { output <- runOperation(ctx, a, text) }(results)
			default:
				if k.r >= 32 && len(line) < 1024*1024 {
					line = append(line, k.r)
					fmt.Print(string(k.r))
				}
			}
		}
	}
}
func printStatus(a *agent.Agent) {
	pwd, _ := os.Getwd()
	tokens := 0
	if a.History != nil {
		tokens = a.History.Tokens()
	}
	fmt.Print(render.StatusLine(a.Config.Model, a.Config.URL, pwd, tokens, a.Config.CompactAt))
	if a.History != nil {
		fmt.Println("会话", filepath.Base(a.History.Dir))
	}

}
func printErr(e error) { fmt.Fprintln(os.Stderr, render.Red("错误：")+fmt.Sprint(e)) }

func localCommand(text string) bool {
	switch text {
	case "/exit", "/quit", "/help", "/status", "/resume", "/messages", "/reset", "/compact":
		return true
	}
	return false
}
