return {
  "hrsh7th/nvim-cmp",

  dependencies = {
    "hrsh7th/cmp-buffer",
    "hrsh7th/cmp-cmdline",
    "hrsh7th/cmp-nvim-lsp",
    "hrsh7th/cmp-path",
    "onsails/lspkind.nvim",
    "petertriho/cmp-git",
    "saadparwaiz1/cmp_luasnip",
  },

  config = function()
    local cmp = require("cmp")
    local luasnip = require("luasnip")

    cmp.setup({
      snippet = {
        expand = function(args)
          luasnip.lsp_expand(args.body)
        end,
      },
      window = {
        completion = cmp.config.window.bordered(),
        documentation = cmp.config.window.bordered(),
      },
      mapping = cmp.mapping.preset.insert({
        ['<C-b>'] = cmp.mapping.scroll_docs(-4),
        ['<C-f>'] = cmp.mapping.scroll_docs(4),
        ['<C-Space>'] = cmp.mapping.complete(),
        ['<C-g>'] = cmp.mapping.abort(),
        ['<Tab>'] = cmp.mapping(function(fallback)
          if cmp.visible() then
            cmp.confirm({ select = true })
          elseif luasnip.expand_or_jumpable() then
            luasnip.expand_or_jump()
          else
            fallback()
          end
        end, { 'i', 's' }),
        ['<S-Tab>'] = cmp.mapping(function(fallback)
          if luasnip.jumpable(-1) then
            luasnip.jump(-1)
          else
            fallback()
          end
        end, { 'i', 's' }),
      }),
      sources = cmp.config.sources({
        { name = 'nvim_lsp' },
        { name = 'luasnip' },
        { name = 'path' },
      }, {
        { name = 'buffer' },
      }),
    })

    cmp.setup.filetype('gitcommit', {
      sources = cmp.config.sources({
        { name = 'git' },
      }, {
        { name = 'buffer' },
      }),
    })
    require("cmp_git").setup({})

    local cmdline_mapping = cmp.mapping.preset.cmdline({
      ['<C-p>'] = { c = cmp.mapping.select_prev_item() },
      ['<C-n>'] = { c = cmp.mapping.select_next_item() },
    })

    cmp.setup.cmdline({ '/', '?' }, {
      mapping = cmdline_mapping,
      sources = {
        { name = 'buffer' },
      },
    })

    cmp.setup.cmdline(':', {
      mapping = cmdline_mapping,
      sources = cmp.config.sources({
        { name = 'path' },
      }, {
        { name = 'cmdline' },
      }),
      matching = {
        disallow_fullfuzzy_matching = false,
        disallow_fuzzy_matching = false,
        disallow_partial_fuzzy_matching = false,
        disallow_partial_matching = false,
        disallow_prefix_unmatching = false,
        disallow_symbol_nonprefix_matching = false,
      },
    })
  end,
}
