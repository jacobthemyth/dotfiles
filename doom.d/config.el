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

(use-package! nov
  :mode ("\\.epub\\'" . nov-mode)
  :config
  (map! :map nov-mode-map
        :n "RET" #'nov-scroll-up)

  (defun doom-modeline-segment--nov-info ()
    (concat
     " "
     (propertize
      (cdr (assoc 'creator nov-metadata))
      'face 'doom-modeline-project-parent-dir)
     " "
     (cdr (assoc 'title nov-metadata))
     " "
     (propertize
      (format "%d/%d"
              (1+ nov-documents-index)
              (length nov-documents))
      'face 'doom-modeline-info)))

  (advice-add 'nov-render-title :override #'ignore)

  (defun +nov-mode-setup ()
    "Tweak nov-mode to our liking."
    ;; (face-remap-add-relative 'variable-pitch
    ;;                          :family "Merriweather"
    ;;                          :height 1.2
    ;;                          :width 'semi-expanded)

    (setq-local line-spacing 0.2
                next-screen-context-lines 4
                shr-use-colors nil)
    (require 'visual-fill-column nil t)
    (setq-local visual-fill-column-center-text t
                visual-fill-column-width 81
                nov-text-width 80)
    (visual-fill-column-mode 1)
    (hl-line-mode -1)
    ;; Re-render with new display settings
    (nov-render-document)
    ;; Look up words with the dictionary.
    (add-to-list '+lookup-definition-functions #'+lookup/dictionary-definition)
    ;; Customise the mode-line to make it more minimal and relevant.
    (setq-local
     mode-line-format
     `((:eval
        (doom-modeline-segment--workspace-name))
       (:eval
        (doom-modeline-segment--window-number))
       (:eval
        (doom-modeline-segment--nov-info))
       ,(propertize
         " %P "
         'face 'doom-modeline-buffer-minor-mode)
       ,(propertize
         " "
         'face (if (doom-modeline--active) 'mode-line 'mode-line-inactive)
         'display `((space
                     :align-to
                     (- (+ right right-fringe right-margin)
                        ,(* (let ((width (doom-modeline--font-width)))
                              (or (and (= width 1) 1)
                                  (/ width (frame-char-width) 1.0)))
                            (string-width
                             (format-mode-line (cons "" '(:eval (doom-modeline-segment--major-mode))))))))))
       (:eval (doom-modeline-segment--major-mode)))))

  (add-hook 'nov-mode-hook #'+nov-mode-setup))

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


(setq auth-sources '("~/.authinfo.gpg"))

;; (defvar rogue-dark-theme 'doom-molokai)
;; (defvar rogue-light-theme 'spacemacs-light)

;; (defvar rogue-current-theme rogue-light-theme
;;   "Currently active color scheme")

;; (defmacro set-pair-faces (themes consts faces-alist)
;;   "Macro for pair setting of custom faces.
;; THEMES name the pair (theme-one theme-two). CONSTS sets the variables like
;;   ((sans-font \"Some Sans Font\") ...). FACES-ALIST has the actual faces
;; like:
;;   ((face1 theme-one-attr theme-two-atrr)
;;    (face2 theme-one-attr nil           )
;;    (face3 nil            theme-two-attr)
;;    ...)"
;;   (defmacro get-proper-faces ()
;;     `(let* (,@consts)
;;        (backquote ,faces-alist)))

;;   `(setq theming-modifications
;;          ',(mapcar (lambda (theme)
;;                      `(,theme ,@(cl-remove-if
;;                                  (lambda (x) (equal x "NA"))
;;                                  (mapcar (lambda (face)
;;                                            (let ((face-name (car face))
;;                                                  (face-attrs (nth (cl-position theme themes) (cdr face))))
;;                                              (if face-attrs
;;                                                  `(,face-name ,@face-attrs)
;;                                                "NA"))) (get-proper-faces)))))
;;                    themes)))

;; (set-pair-faces
;;  ;; Themes to cycle in
;;  (doom-molokai spacemacs-light)

;;  ;; Variables
;;  ((bg-white           "#fbf8ef")
;;   (bg-light           "#222425")
;;   (bg-dark            "#1c1e1f")
;;   (bg-darker          "#1c1c1c")
;;   (fg-white           "#ffffff")
;;   (shade-white        "#efeae9")
;;   (fg-light           "#655370")
;;   (dark-cyan          "#008b8b")
;;   (region-dark        "#2d2e2e")
;;   (region             "#39393d")
;;   (slate              "#8FA1B3")
;;   (keyword            "#f92672")
;;   (comment            "#525254")
;;   (builtin            "#fd971f")
;;   (purple             "#9c91e4")
;;   (doc                "#727280")
;;   (type               "#66d9ef")
;;   (string             "#b6e63e")
;;   (gray-dark          "#999")
;;   (gray               "#bbb")
;;   (sans-font          "Source Sans Pro")
;;   (serif-font         "Merriweather")
;;   (et-font            "EtBembo")
;;   (sans-mono-font     "Souce Code Pro")
;;   (serif-mono-font    "Verily Serif Mono"))

;;  ;; Settings
;;  ((variable-pitch
;;    (:family ,sans-font)
;;    (:family ,et-font
;;             :background nil
;;             :foreground ,bg-dark
;;             :height 1.7))
;;   (header-line
;;    (:background nil :inherit nil)
;;    (:background nil :inherit nil))
;;   (eval-sexp-fu-flash
;;    (:background ,dark-cyan
;;                 :foreground ,fg-white)
;;    nil)
;;   (eval-sexp-fu-flash-error
;;    (:background ,keyword
;;                 :foreground ,fg-white)
;;    nil)
;;   (hackernews-link-face
;;    (:foreground ,slate
;;                 :inherit variable-pitch
;;                 :height 1.2)
;;    nil)
;;   (hackernews-comment-count-face
;;    (:foreground ,string)
;;    nil)
;;   (company-tooltip
;;    (:background ,bg-darker
;;                 :foreground ,gray)
;;    nil)
;;   (company-scrollbar-fg
;;    (:background ,comment)
;;    nil)
;;   (company-scrollbar-bg
;;    (:background ,bg-darker)
;;    nil)
;;   (company-tooltip-common
;;    (:foreground ,keyword)
;;    nil)
;;   (company-tootip-annotation
;;    (:foreground ,type)
;;    nil)
;;   (company-tooltip-selection
;;    (:background ,region)
;;    nil)
;;   (show-paren-match
;;    (:background ,keyword
;;                 :foreground ,bg-dark)
;;    nil)
;;   (magit-section-heading
;;    (:foreground ,keyword)
;;    nil)
;;   (magit-header-line
;;    (:background nil
;;                 :foreground ,bg-dark
;;                 :box nil)
;;    (:background nil
;;                 :foreground ,bg-white
;;                 :box nil))
;;   (magit-diff-hunk-heading
;;    (:background ,comment
;;                 :foreground ,gray)
;;    nil)
;;   (magit-diff-hunk-heading-highlight
;;    (:background ,comment
;;                 :foreground ,fg-white)
;;    nil)
;;   (tooltip
;;    (:foreground ,gray
;;                 :background ,bg-darker)
;;    nil)
;;   (git-gutter-fr:modified
;;    (:foreground ,dark-cyan)
;;    nil)
;;   (doom-neotree-dir-face
;;    (:foreground ,keyword
;;                 :height 1.0)
;;    (:family ,sans-font
;;             :height 1.0))
;;   (doom-neotree-file-face
;;    (:height 1.0)
;;    (:family ,sans-font
;;             :height 1.0))
;;   (doom-neotree-text-file-face
;;    (:height 1.0)
;;    (:family ,sans-font
;;             :height 1.0))
;;   (doom-neotree-hidden-file-face
;;    (:height 1.0
;;             :foreground ,comment)
;;    (:family ,sans-font
;;             :height 1.0
;;             :foreground ,comment))
;;   (doom-neotree-media-file-face
;;    (:height 1.0
;;             :foreground ,type)
;;    (:family ,sans-font
;;             :height 1.0
;;             :foreground ,type))
;;   (doom-neotree-data-file-face
;;    (:height 1.0
;;             :foreground ,doc)
;;    (:family ,sans-font
;;             :height 1.0
;;             :foreground ,doc))
;;   (neo-root-dir-face
;;    (:foreground ,fg-white
;;                 :background ,region-dark
;;                 :box (:line-width 6 :color ,region-dark))
;;    nil)
;;   (mode-line
;;    (:background ,bg-darker)
;;    (:background ,bg-white
;;                 :box nil))
;;   (mode-line-inactive
;;    nil
;;    (:box nil))
;;   (powerline-active1
;;    nil
;;    (:background ,bg-white))
;;   (powerline-active2
;;    nil
;;    (:background ,bg-white))
;;   (powerline-inactive1
;;    nil
;;    (:background ,bg-white))
;;   (powerline-inactive2
;;    nil
;;    (:background ,bg-white))
;;   (highlight
;;    (:background ,region
;;                 :foreground ,fg-white)
;;    (:background ,shade-white))
;;   (hl-line
;;    (:background ,region-dark)
;;    nil)
;;   (solaire-hl-line-face
;;    (:background ,bg-dark)
;;    nil)
;;   (org-document-title
;;    (:inherit variable-pitch
;;              :height 1.3
;;              :weight normal
;;              :foreground ,gray)
;;    (:inherit nil
;;              :family ,et-font
;;              :height 1.8
;;              :foreground ,bg-dark
;;              :underline nil))
;;   (org-document-info
;;    (:foreground ,gray
;;                 :slant italic)
;;    (:height 1.2
;;             :slant italic))
;;   (org-level-1
;;    (:inherit variable-pitch
;;              :height 1.3
;;              :weight bold
;;              :foreground ,keyword
;;              :background ,bg-dark)
;;    (:inherit nil
;;              :family ,et-font
;;              :height 1.6
;;              :weight normal
;;              :slant normal
;;              :foreground ,bg-dark))
;;   (org-level-2
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.2
;;              :foreground ,gray
;;              :background ,bg-dark)
;;    (:inherit nil
;;              :family ,et-font
;;              :weight normal
;;              :height 1.3
;;              :slant italic
;;              :foreground ,bg-dark))
;;   (org-level-3
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.1
;;              :foreground ,slate
;;              :background ,bg-dark)
;;    (:inherit nil
;;              :family ,et-font
;;              :weight normal
;;              :slant italic
;;              :height 1.2
;;              :foreground ,bg-dark))
;;   (org-level-4
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.1
;;              :foreground ,slate
;;              :background ,bg-dark)
;;    (:inherit nil
;;              :family ,et-font
;;              :weight normal
;;              :slant italic
;;              :height 1.1
;;              :foreground ,bg-dark))
;;   (org-level-5
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.1
;;              :foreground ,slate
;;              :background ,bg-dark)
;;    nil)
;;   (org-level-6
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.1
;;              :foreground ,slate
;;              :background ,bg-dark)
;;    nil)
;;   (org-level-7
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.1
;;              :foreground ,slate
;;              :background ,bg-dark)
;;    nil)
;;   (org-level-8
;;    (:inherit variable-pitch
;;              :weight bold
;;              :height 1.1
;;              :foreground ,slate
;;              :background ,bg-dark)
;;    nil)
;;   (org-headline-done
;;    (:strike-through t)
;;    (:family ,et-font
;;             :strike-through t))
;;   (org-quote
;;    (:background ,bg-dark)
;;    nil)
;;   (org-block
;;    (:background ,bg-dark)
;;    (:background nil
;;                 :foreground ,bg-dark))
;;   (org-block-begin-line
;;    (:background ,bg-dark)
;;    (:background nil
;;                 :height 0.8
;;                 :family ,sans-mono-font
;;                 :foreground ,slate))
;;   (org-block-end-line
;;    (:background ,bg-dark)
;;    (:background nil
;;                 :height 0.8
;;                 :family ,sans-mono-font
;;                 :foreground ,slate))
;;   (org-document-info-keyword
;;    (:foreground ,comment)
;;    (:height 0.8
;;             :foreground ,gray))
;;   (org-link
;;    (:underline nil
;;                :weight normal
;;                :foreground ,slate)
;;    (:foreground ,bg-dark))
;;   (org-special-keyword
;;    (:height 0.9
;;             :foreground ,comment)
;;    (:family ,sans-mono-font
;;             :height 0.8))
;;   (org-todo
;;    (:foreground ,builtin
;;                 :background ,bg-dark)
;;    nil)
;;   (org-done
;;    (:inherit variable-pitch
;;              :foreground ,dark-cyan
;;              :background ,bg-dark)
;;    nil)
;;   (org-agenda-current-time
;;    (:foreground ,slate)
;;    nil)
;;   (org-hide
;;    nil
;;    (:foreground ,bg-white))
;;   (org-indent
;;    (:inherit org-hide)
;;    (:inherit (org-hide fixed-pitch)))
;;   (org-time-grid
;;    (:foreground ,comment)
;;    nil)
;;   (org-warning
;;    (:foreground ,builtin)
;;    nil)
;;   (org-date
;;    nil
;;    (:family ,sans-mono-font
;;             :height 0.8))
;;   (org-agenda-structure
;;    (:height 1.3
;;             :foreground ,doc
;;             :weight normal
;;             :inherit variable-pitch)
;;    nil)
;;   (org-agenda-date
;;    (:foreground ,doc
;;                 :inherit variable-pitch)
;;    (:inherit variable-pitch
;;              :height 1.1))
;;   (org-agenda-date-today
;;    (:height 1.5
;;             :foreground ,keyword
;;             :inherit variable-pitch)
;;    nil)
;;   (org-agenda-date-weekend
;;    (:inherit org-agenda-date)
;;    nil)
;;   (org-scheduled
;;    (:foreground ,gray)
;;    nil)
;;   (org-upcoming-deadline
;;    (:foreground ,keyword)
;;    nil)
;;   (org-scheduled-today
;;    (:foreground ,fg-white)
;;    nil)
;;   (org-scheduled-previously
;;    (:foreground ,slate)
;;    nil)
;;   (org-agenda-done
;;    (:inherit nil
;;              :strike-through t
;;              :foreground ,doc)
;;    (:strike-through t
;;                     :foreground ,doc))
;;   (org-ellipsis
;;    (:underline nil
;;                :foreground ,comment)
;;    (:underline nil
;;                :foreground ,comment))
;;   (org-tag
;;    (:foreground ,doc)
;;    (:foreground ,doc))
;;   (org-table
;;    (:background nil)
;;    (:family ,serif-mono-font
;;             :height 0.9
;;             :background ,bg-white))
;;   (org-code
;;    (:inherit font-lock-builtin-face)
;;    (:inherit nil
;;              :family ,serif-mono-font
;;              :foreground ,comment
;;              :height 0.9))
;;   (font-latex-sectioning-0-face
;;    (:foreground ,type
;;                 :height 1.2)
;;    nil)
;;   (font-latex-sectioning-1-face
;;    (:foreground ,type
;;                 :height 1.1)
;;    nil)
;;   (font-latex-sectioning-2-face
;;    (:foreground ,type
;;                 :height 1.1)
;;    nil)
;;   (font-latex-sectioning-3-face
;;    (:foreground ,type
;;                 :height 1.0)
;;    nil)
;;   (font-latex-sectioning-4-face
;;    (:foreground ,type
;;                 :height 1.0)
;;    nil)
;;   (font-latex-sectioning-5-face
;;    (:foreground ,type
;;                 :height 1.0)
;;    nil)
;;   (font-latex-verbatim-face
;;    (:foreground ,builtin)
;;    nil)
;;   (spacemacs-normal-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (spacemacs-evilified-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (spacemacs-lisp-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (spacemacs-emacs-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (spacemacs-motion-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (spacemacs-visual-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (spacemacs-hybrid-face
;;    (:background ,bg-dark
;;                 :foreground ,fg-white)
;;    nil)
;;   (bm-persistent-face
;;    (:background ,dark-cyan
;;                 :foreground ,fg-white)
;;    nil)
;;   (helm-selection
;;    (:background ,region)
;;    nil)
;;   (helm-match
;;    (:foreground ,keyword)
;;    nil)
;;   (cfw:face-title
;;    (:height 2.0
;;             :inherit variable-pitch
;;             :weight bold
;;             :foreground ,doc)
;;    nil)
;;   (cfw:face-holiday
;;    (:foreground ,builtin)
;;    nil)
;;   (cfw:face-saturday
;;    (:foreground ,doc
;;                 :weight bold)
;;    nil)
;;   (cfw:face-sunday
;;    (:foreground ,doc)
;;    nil)
;;   (cfw:face-periods
;;    (:foreground ,dark-cyan)
;;    nil)
;;   (cfw:face-annotation
;;    (:foreground ,doc)
;;    nil)
;;   (cfw:face-select
;;    (:background ,region)
;;    nil)
;;   (cfw:face-toolbar-button-off
;;    (:foreground ,doc)
;;    nil)
;;   (cfw:face-toolbar-button-on
;;    (:foreground ,type
;;                 :weight bold)
;;    nil)
;;   (cfw:face-day-title
;;    (:foreground ,doc)
;;    nil)
;;   (cfw:face-default-content
;;    (:foreground ,dark-cyan)
;;    nil)
;;   (cfw:face-disable
;;    (:foreground ,doc)
;;    nil)
;;   (cfw:face-today
;;    (:background ,region
;;                 :weight bold)
;;    nil)
;;   (cfw:face-toolbar
;;    (:inherit default)
;;    nil)
;;   (cfw:face-today-title
;;    (:background ,keyword
;;                 :foreground ,fg-white)
;;    nil)
;;   (cfw:face-grid
;;    (:foreground ,comment)
;;    nil)
;;   (cfw:face-header
;;    (:foreground ,keyword
;;                 :weight bold)
;;    nil)
;;   (cfw:face-default-day
;;    (:foreground ,fg-white)
;;    nil)
;;   (dired-subtree-depth-1-face
;;    (:background nil)
;;    nil)
;;   (dired-subtree-depth-2-face
;;    (:background nil)
;;    nil)
;;   (dired-subtree-depth-3-face
;;    (:background nil)
;;    nil)
;;   (dired-subtree-depth-4-face
;;    (:background nil)
;;    nil)
;;   (dired-subtree-depth-5-face
;;    (:background nil)
;;    nil)
;;   (dired-subtree-depth-6-face
;;    (:background nil)
;;    nil)
;;   (nlinum-current-line
;;    (:foreground ,builtin)
;;    (:foreground ,bg-dark))
;;   (vertical-border
;;    (:background ,region
;;                 :foreground ,region)
;;    nil)
;;   (which-key-command-description-face
;;    (:foreground ,type)
;;    nil)
;;   (flycheck-error
;;    (:background nil)
;;    nil)
;;   (flycheck-warning
;;    (:background nil)
;;    nil)
;;   (font-lock-string-face
;;    (:foreground ,string)
;;    nil)
;;   (font-lock-comment-face
;;    (:foreground ,doc
;;                 :slant italic)
;;    (:background nil
;;                 :foreground ,doc
;;                 :slant italic))
;;   (helm-ff-symlink
;;    (:foreground ,slate)
;;    nil)
;;   (region
;;    (:background ,region)
;;    nil)
;;   (header-line
;;    (:background nil
;;                 :inherit nil)
;;    (:background nil
;;                 :inherit nil))))

;; (let ((et-font "EtBembo")
;;       (serif-mono-font "EtBembo")
;;       (sans-mono-font "EtBembo")
;;       (slate (doom-color 'grey))
;;       (gray (doom-color 'grey))
;;       (bg-dark (doom-color 'fg))
;;       (bg-white (doom-color 'base8))
;;       (doc (doom-color 'doc-comments))
;;       (comment (doom-color 'comments)))
;;   (custom-set-faces!
;;     `(variable-pitch
;;       :family ,et-font
;;       :background nil
;;       :foreground ,bg-dark
;;       :height 1.7)
;;     `(org-document-title
;;       :inherit nil
;;       :family ,et-font
;;       :height 1.8
;;       :foreground ,bg-dark
;;       :underline nil)
;;     `(org-document-info
;;       :height 1.2
;;       :slant italic)
;;     `(org-level-1
;;       :inherit nil
;;       :family ,et-font
;;       :height 1.6
;;       :weight normal
;;       :slant normal
;;       :foreground ,bg-dark)
;;     `(org-level-2
;;       :inherit nil
;;       :family ,et-font
;;       :weight normal
;;       :height 1.3
;;       :slant italic
;;       :foreground ,bg-dark)
;;     `(org-level-3
;;       :inherit nil
;;       :family ,et-font
;;       :weight normal
;;       :slant italic
;;       :height 1.2
;;       :foreground ,bg-dark)
;;     `(org-level-4
;;       :inherit nil
;;       :family ,et-font
;;       :weight normal
;;       :slant italic
;;       :height 1.1
;;       :foreground ,bg-dark)
;;     `(org-headline-done
;;       :family ,et-font
;;       :strike-through t)
;;     `(org-block
;;       :background nil
;;       :foreground ,bg-dark)
;;     `(org-block-begin-line
;;       :background nil
;;       :height 0.8
;;       :family ,sans-mono-font
;;       :foreground ,slate)
;;     `(org-block-end-line
;;       :background nil
;;       :height 0.8
;;       :family ,sans-mono-font
;;       :foreground ,slate)
;;     `(org-document-info-keyword
;;       :height 0.8
;;       :foreground ,gray)
;;     `(org-link
;;       :foreground ,bg-dark)
;;     `(org-special-keyword
;;       :family ,sans-mono-font
;;       :height 0.8)
;;     `(org-hide
;;       :foreground ,bg-white)
;;     `(org-indent
;;       :inherit (org-hide fixed-pitch))
;;     `(org-date
;;       :family ,sans-mono-font
;;       :height 0.8)
;;     `(org-agenda-date
;;       :inherit variable-pitch
;;       :height 1.1)
;;     `(org-agenda-done
;;       :strike-through t
;;       :foreground ,doc)
;;     `(org-ellipsis
;;       :underline nil
;;       :foreground ,comment)
;;     `(org-tag
;;       :foreground ,doc)
;;     `(org-table
;;       :family ,serif-mono-font
;;       :height 0.9
;;       :background ,bg-white)
;;     `(org-code
;;       :inherit nil
;;       :family ,serif-mono-font
;;       :foreground ,comment
;;       :height 0.9)))

(defun my/name-tab-by-project-or-default ()
  "Return project name if in a project, or default tab-bar name if not.
The default tab-bar name uses the buffer name."
  (let ((project-name (projectile-project-name)))
    (if (string= "-" project-name)
        (tab-bar-tab-name-current)
      (projectile-project-name))))

(setq tab-bar-mode t)
(setq tab-bar-new-tab-choice "*doom*")
(setq tab-bar-tab-name-function #'my/name-tab-by-project-or-default)

(map! :leader
      (:prefix-map ("TAB" . "Tabs")
       :desc "Switch tab" "TAB" #'tab-bar-select-tab-by-name
       :desc "New tab" "n" #'tab-bar-new-tab
       :desc "Rename tab" "r" #'tab-bar-rename-tab
       :desc "Rename tab by name" "R" #'tab-bar-rename-tab-by-name
       :desc "Close tab" "d" #'tab-bar-close-tab
       :desc "Close tab by name" "D" #'tab-bar-close-tab-by-name
       :desc "Close other tabs" "1" #'tab-bar-close-other-tabs))
