module.exports = {
    content: [
        './launchpad/index.html',
        './launchpad/operator/index.html',
        './mint/index.html',
    ],
    theme: {
        extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'] },
            colors: {
                'brand-primary': '#3B82F6',
                'brand-primary-hover': '#60A5FA',
                'brand-secondary': '#FACC15',
                'dark-bg': '#111827',
                'dark-card': '#1F2937',
                'dark-text': '#E5E7EB',
                'dark-text-secondary': '#9CA3AF',
            },
            boxShadow: {
                glow: '0 0 0 1px rgba(59,130,246,.18), 0 24px 60px rgba(15,23,42,.45)',
            },
        },
    },
};
