;;; $DOOMDIR/config.el -*- lexical-binding: t; -*-

;; Place your private configuration here! Remember, you do not need to run 'doom
;; sync' after modifying this file!

;;; Code:

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
(setq doom-font (font-spec :family "OperatorMonoSSm Nerd Font Mono" :weight 'medium :size 14)
      doom-variable-pitch-font (font-spec :family "New York" :weight 'medium :size 16))

;; There are two ways to load a theme. Both assume the theme is installed and
;; available. You can either set `doom-theme' or manually load a theme with the
;; `load-theme' function. This is the default:
(setq doom-theme 'doom-one)

; (setq mac-option-modifier       'meta
;       ns-option-modifier        'meta
;       mac-right-option-modifier 'meta
;       ns-right-option-modifier  'meta)

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

(after! org
  (setq org-agenda-custom-commands `(("P" "Plan The Day" ((agenda)
                                                          (tags-todo "@office")
                                                          (tags-todo "@home")
                                                          (tags-todo "@computer")
                                                          (tags-todo "@phone")
                                                          (tags-todo "PROJECT")))
                                     ("T" "Today" ((agenda "" ((org-agenda-span 'day)
                                                               (org-agenda-start-day "+0d")
                                                               (org-deadline-warning-days 0)
                                                               ))))))
  (let ((systemist-org-root "~/Library/CloudStorage/Dropbox/org"))
    (setq org-directory "~/Library/CloudStorage/Dropbox/org/")
    (setq org-noter-notes-search-path '("~/Library/CloudStorage/Dropbox/org/Bibliographic Notes"))
    (setq org-noter-always-create-frame nil)
    (setq org-agenda-files '("~/Library/CloudStorage/Dropbox/org/"))
    (setq org-archive-location "~/Library/CloudStorage/Dropbox/org/.archive/%s_archive::")
    (setq org-capture-templates
          '(("t" "todo" entry (file "~/Library/CloudStorage/Dropbox/org/inbox.org")
            "* TODO %?\n%U\n%a\n" :clock-in t :clock-resume t)
            ("r" "respond" entry (file "~/Library/CloudStorage/Dropbox/org/inbox.org")
            "* TODO Respond to %:from on %:subject\nSCHEDULED: %t\n%U\n%a\n" :clock-in t :clock-resume t :immediate-finish t)
            ("n" "note" entry (file "~/Library/CloudStorage/Dropbox/org/inbox.org")
            "* %? :NOTE:\n%U\n%a\n" :clock-in t :clock-resume t)
            ("w" "org-protocol" entry (file "~/Library/CloudStorage/Dropbox/org/inbox.org")
            "* TODO Review %c\n%U\n" :immediate-finish t)
            ("p" "Phone call" entry (file "~/Library/CloudStorage/Dropbox/org/inbox.org")
            "* TODO %? :PHONE:\n%U" :clock-in t :clock-resume t)))
    (setq org-default-notes-file "~/Library/CloudStorage/Dropbox/org/inbox.org")
    (setq org-refile-targets '((org-agenda-files :maxlevel . 1)
                              ("~/Library/CloudStorage/Dropbox/org/projects.org" :maxlevel . 2)
                              ("~/Library/CloudStorage/Dropbox/org/reference.org" :maxlevel . 2))))
  (setq org-log-done 'time)
  (setq org-startup-folded t)
  (setq org-tag-alist '(("@work" . ?w) ("@home" . ?h) ("@computer" . ?c)))
  (setq org-todo-keywords
        '((sequence "TODO(t)" "STARTED(s)" "WAITING(w)" "|" "DONE(d)" "CANCELLED(c) DEFERRED(f)")))
  (map!
   :n "gj" #'evil-next-visual-line
   :n "gk" #'evil-previous-visual-line))

(after! org-roam
  (setq +org-roam-open-buffer-on-find-file nil)
  (setq org-roam-link-auto-replace nil)
  (setq org-roam-directory "~/Library/CloudStorage/Dropbox/org/Notes"))

;; This determines the style of line numbers in effect. If set to `nil', line
;; numbers are disabled. For relative line numbers, set this to `relative'.
(setq display-line-numbers-type t)

(setq menu-bar-mode t)

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

(map!
 :nv "gx" #'browse-url-at-point
 :n "-" #'dired-jump
 :n "s-RET" #'toggle-frame-fullscreen)

(map! :map dired-mode-map
      :n "%" 'dired-create-empty-file)


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

(setq auth-sources '("~/.authinfo.gpg"))

(setq tab-bar-mode t)
(setq tab-bar-new-tab-choice "*doom*")

(defun org-html--format-image (source attributes info)
  (progn
    (setq source (replace-in-string "%20" " " source))
    (format "<img src=\"data:image/%s;base64,%s\"%s />"
            (or (file-name-extension source) "")
            (base64-encode-string
             (with-temp-buffer
               (insert-file-contents-literally source)
              (buffer-string)))
            (file-name-nondirectory source))))
