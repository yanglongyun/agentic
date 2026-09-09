package render

import "fmt"

func ResumeHeader(page, pages int) string {
	return "\n  " + Bold("历史会话") + "  " + Gray(fmt.Sprintf("%d / %d", page, pages)) + "\n\n"
}

func ResumeRow(number int, preview, updated, id string, current bool) string {
	title := preview
	if preview == "（空会话）" || preview == "（已有消息）" {
		title = Gray(preview)
	} else if current {
		title = Bold(preview)
	}
	marker := ""
	if current {
		marker = "  " + Green("● 当前")
	}
	return "  " + Cyan(fmt.Sprintf("%2d", number)) + "  " + title + marker + "\n" +
		"      " + Gray(updated+" · "+id) + "\n\n"
}

func ResumeNavigation(page, pages int) string {
	previous, next := Gray("p 上一页"), Gray("n 下一页")
	if page > 1 {
		previous = Cyan("p") + " 上一页"
	}
	if page < pages {
		next = Cyan("n") + " 下一页"
	}
	return "  " + previous + Gray(" · ") + next + Gray(" · ") + Cyan("Esc") + " 返回\n"
}
