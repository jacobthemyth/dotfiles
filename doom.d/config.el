;;; $DOOMDIR/config.el -*- lexical-binding: t; -*-

;; Place your private configuration here! Remember, you do not need to run 'doom
;; sync' after modifying this file!


;; Some functionality uses this to identify you, e.g. GPG configuration, email
;; clients, file templates and snippets.
(setq user-full-name "Jacob Smith"
      user-mail-address "jacob@jacobsmith.io")

;; Doom exposes five (optional) variables for controlling fonts in Doom. Here
;; are the three important ones:
;;
;; + `doom-font'
;; + `doom-variable-pitch-font'
;; + `doom-big-font' -- used for `doom-big-font-mode'; use this for
;;   presentations or streaming.
;;
;; They all accept either a font-spec, font string ("Input Mono-12"), or xlfd
;; font string. You generally only need these two:
;; (setq doom-font (font-spec :family "Operator Mono SSm for Powerline" :size 16)
;;       doom-variable-pitch-font (font-spec :family "sans" :size 13))

;; There are two ways to load a theme. Both assume the theme is installed and
;; available. You can either set `doom-theme' or manually load a theme with the
;; `load-theme' function. This is the default:
(setq doom-theme 'doom-one)

;; If you use `org' and don't want your org files in the default location below,
;; change `org-directory'. It must be set before org loads!
(setq org-directory "~/Dropbox/org/")
(setq org-roam-directory "~/Dropbox/org/")
(setq org-archive-location "~/Dropbox/org/.archive/%s_archive::")
(setq org-jira-working-dir "~/Dropbox/org-jira")
(setq jiralib-url "https://kajabi.atlassian.net")

;; This determines the style of line numbers in effect. If set to `nil', line
;; numbers are disabled. For relative line numbers, set this to `relative'.
(setq display-line-numbers-type t)

(setq menu-bar-mode t)

;; Here are some additional functions/macros that could help you configure Doom:
;;
;; - `load!' for loading external *.el files relative to this one
;; - `use-package!' for configuring packages
;; - `after!' for running code after a package has loaded
;; - `add-load-path!' for adding directories to the `load-path', relative to
;;   this file. Emacs searches the `load-path' when you load packages with
;;   `require' or `use-package'.
;; - `map!' for binding new keys
;;
;; To get information about any of these functions/macros, move the cursor over
;; the highlighted symbol at press 'K' (non-evil users must press 'C-c c k').
;; This will open documentation for it, including demos of how they are used.
;;
;; You can also try 'gd' (or 'C-c c d') to jump to their definition and see how
;; they are implemented.

(setq org-capture-templates
      (quote (("t" "todo" entry (file "~/Dropbox/org/todo.org")
               "* TODO %?\n%a\n"))))

(defun systemist/copy-as-rtf ()
  "Export region to RTF and copy it to the clipboard."
  (interactive)
  (save-window-excursion
    (let* ((buf (org-export-to-buffer 'html "*Formatted Copy*" nil nil t t))
           (html (with-current-buffer buf (buffer-string))))
      (with-current-buffer buf
        (shell-command-on-region
         (point-min)
         (point-max)
         "textutil -stdin -format html -convert rtf -stdout | pbcopy"))
      (kill-buffer buf))))

(add-hook 'markdown-mode-hook #'systemist/markdown-mode-hook)
(defun systemist/markdown-mode-hook ()
  "Custom `markdown-mode` behaviors."
  (critic-minor-mode))

(add-hook 'org-mode-hook #'systemist/org-mode-hook)
(defun systemist/org-mode-hook ()
  "Custom `org-mode` behaviors."
  (critic-minor-mode))

(add-hook 'dired-mode-hook 'dired-hide-details-mode)

(setq +org-roam-open-buffer-on-find-file nil)

(map! :nv "gx" #'browse-url-at-point)

(map! :n "M-RET" #'toggle-frame-fullscreen)

(map! :n "-" #'dired-jump)

(setq org-roam-link-auto-replace nil)

(defun systemist/resize-org-images (&rest _)
  (setq org-image-actual-width (list (round (* 0.8 (window-body-width nil t)))))
  (unless org-inline-image-overlays
    (org-redisplay-inline-images)))

(add-hook 'window-size-change-functions 'systemist/resize-org-images)

(setq ob-mermaid-cli-path "/usr/local/bin/mmdc")

(org-babel-do-load-languages
    'org-babel-load-languages
    '((mermaid . t)
      (elisp . t)))

;; (defconst org-jira-progress-issue-flow
;;   '(
;;     ("To Do" . "In Progress"
;;     ("In Progress" . "Done"))))

(setq org-jira-custom-jqls
  '(
    (:jql "status IN ('Backlog', 'To Do', 'In Progress', 'Work in progress', 'Open', 'Specify') AND assignee = 'Jake Smith'"
     :limit 50
     :filename "my-work")
    ))

(setq jiralib-update-issue-fields-exclude-list '(priority components))

(setq format-all-formatters
      '(("SQL" pgformatter)))

(add-hook 'sql-mode-hook #'format-all-mode)

(eval-after-load "org-present"
  '(progn
     (add-hook 'org-present-mode-hook
               (lambda ()
                 ;; (org-present-big)
                 (org-display-inline-images)
                 (org-present-hide-cursor)
                 (org-present-read-only)))
     (add-hook 'org-present-mode-quit-hook
               (lambda ()
                 ;; (org-present-small)
                 (org-remove-inline-images)
                 (org-present-show-cursor)
                 (org-present-read-write)))))
